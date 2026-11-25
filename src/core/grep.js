// grep 搜尋：用樣式（regex）逐行比對，回傳命中的行。與關鍵字搜尋互補，適合找函式名、暫存器位址、錯誤碼這類有固定格式的東西。
//
// 寫壞的樣式可能讓比對跑非常久，所以比對在另一個行程執行並設時間上限，逾時就中止，不會卡住呼叫端。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, MARKDOWN_EXTENSIONS } from './constants.js';
import { listHeadings } from './markdown.js';
import { readTextFile } from './text.js';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grep-child.js');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把樣式編譯成不分大小寫的 regex。寫法不合法時改當成純文字。
 * @returns {{ re: RegExp, literal: boolean }} literal：樣式不是合法的 regex，已當成純文字比對
 */
export function compilePattern(pattern) {
  // 先用嚴格的 Unicode 模式；它不接受多餘的跳脫（例如 \_），這時退回寬鬆模式
  for (const flags of ['iu', 'i']) {
    try {
      return { re: new RegExp(pattern, flags), literal: false };
    } catch { /* 換下一種 */ }
  }
  return { re: new RegExp(escapeRegex(pattern), 'iu'), literal: true };
}

function clip(line, at) {
  const text = line.trim();
  if (text.length <= LIMITS.snippetChars) return text;
  const start = Math.max(0, Math.min(at - 30, text.length - LIMITS.snippetChars));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + LIMITS.snippetChars)}${start + LIMITS.snippetChars < text.length ? '…' : ''}`;
}

// 函式定義的樣子：頂格、以識別字開頭、有左括號、整行沒有分號（有分號的是宣告或敘述）。函式名是第一個左括號前面的識別字
const DEFINITION = /^(?=[A-Za-z_$])[^;(]*?([A-Za-z_$][\w$]*)\s*\([^;]*$/;
// 用關鍵字宣告的定義可以有縮排（例如類別裡的方法）
const KEYWORD_DEFINITION = /^\s*(?:async\s+)?(?:def|class|function|func|fn|sub)\s+([A-Za-z_$][\w$]*)/;
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'do', 'catch']);

/**
 * 這一行位在哪個函式裡。往上找最近的函式定義；先遇到頂格的右大括號代表這一行不在任何函式裡。
 * 用通用的規則判斷，認不出來時回傳 null，不猜。
 * @param {string[]} lines 整個檔案
 * @param {number} index 命中行的索引（從 0 起算）
 * @returns {string|null}
 */
export function enclosingFunction(lines, index) {
  for (let i = index - 1; i >= 0 && index - i <= LIMITS.grepScopeScanLines; i--) {
    const line = lines[i];
    const keyword = KEYWORD_DEFINITION.exec(line);
    if (keyword) return keyword[1];
    if (line.startsWith('}')) return null;
    const m = DEFINITION.exec(line);
    if (m && !NOT_A_NAME.has(m[1])) return m[1];
  }
  return null;
}

const cut = (line) => (line.length > LIMITS.grepContextLineChars ? `${line.slice(0, LIMITS.grepContextLineChars)}…` : line);

/**
 * 把命中行連同前後幾行組成區塊，範圍重疊或相連的併成一塊。
 * @returns {{ hits: { line: number, where: string|null }[], lines: { line: number, text: string, hit: boolean }[] }[]}
 */
function contextBlocks(lines, hits, context) {
  const blocks = [];
  for (const h of hits) {
    const start = Math.max(1, h.line - context);
    const end = Math.min(lines.length, h.line + context);
    const last = blocks.at(-1);
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.hits.push({ line: h.line, where: h.where });
    } else blocks.push({ hits: [{ line: h.line, where: h.where }], start, end });
  }
  const hitLines = new Set(hits.map((h) => h.line));
  return blocks.map((b) => ({
    hits: b.hits,
    lines: lines.slice(b.start - 1, b.end).map((text, i) => ({ line: b.start + i, text: cut(text), hit: hitLines.has(b.start + i) })),
  }));
}

/**
 * 逐行比對。以檔案為單位回傳，命中行數多的排前面。全形與半形視為相同。
 * 每個命中行附上它在哪裡：程式碼是所在的函式，markdown 是所在的章節。
 *
 * 前後文只附在這次要顯示的結果（offset 起的 limit 筆）上，而且總行數有上限：依序附到額度用完，其餘的命中只有那一行。
 * 沒有指定 context 時自動決定：命中的行很少就附前後文，多的話只列出每一行。
 * @param {{ kb: string|null, files: { path: string, text: string }[] }[]} sources
 * @param {string} pattern
 * @param {{ context?: number|null, offset?: number, limit?: number }} [opts] context：命中行前後各幾行；null 表示自動決定
 * @returns {{ results: { kb: string|null, path: string, hitCount: number, hits: { line: number, text: string, where: string|null, expanded: boolean }[], blocks: object[] }[],
 *   total: number, totalHits: number, literal: boolean, context: number, auto: boolean, expanded: number, collapsed: number }}
 *   context：實際使用的前後文行數；auto：是不是自動決定的；expanded／collapsed：這次顯示的命中裡，有附與沒附前後文的各幾筆
 */
export function grepLines(sources, pattern, opts = {}) {
  const { re, literal } = compilePattern(pattern);
  const out = [];
  const fileLines = new Map();
  for (const src of sources) {
    for (const file of src.files) {
      const hits = [];
      let hitCount = 0;
      const lines = file.text.split(/\r?\n/);
      lines.forEach((raw, i) => {
        const line = raw.length > LIMITS.grepMaxLineChars ? raw.slice(0, LIMITS.grepMaxLineChars) : raw;
        const m = re.exec(line) ?? re.exec(line.normalize('NFKC'));
        if (!m) return;
        hitCount++;
        if (hits.length < LIMITS.grepHitsPerFile) hits.push({ line: i + 1, text: clip(line, m.index) });
      });
      if (hitCount === 0) continue;
      const headings = MARKDOWN_EXTENSIONS.includes(path.extname(file.path).toLowerCase()) ? listHeadings(lines) : null;
      for (const h of hits) {
        const section = headings?.findLast((x) => x.line < h.line)?.text;
        h.where = headings ? (section ? `章節：${section}` : null) : (enclosingFunction(lines, h.line - 1) ?? null);
        if (h.where && !headings) h.where = `在 ${h.where} 裡`;
        h.expanded = false;
      }
      const result = { kb: src.kb, path: file.path, hitCount, hits, blocks: [] };
      fileLines.set(result, lines);
      out.push(result);
    }
  }
  out.sort((a, b) => b.hitCount - a.hitCount || (`${a.kb}:${a.path}` < `${b.kb}:${b.path}` ? -1 : 1));

  const totalHits = out.reduce((n, r) => n + r.hitCount, 0);
  const auto = opts.context === undefined || opts.context === null;
  const context = auto ? (totalHits <= LIMITS.grepAutoContextMaxHits ? LIMITS.grepAutoContext : 0) : Math.min(Math.max(0, Math.trunc(opts.context)), LIMITS.grepMaxContext);
  const offset = opts.offset ?? 0;
  const shown = out.slice(offset, offset + (opts.limit ?? out.length));
  let budget = LIMITS.grepContextBudgetLines;
  let expanded = 0;
  for (const r of context > 0 ? shown : []) {
    const lines = fileLines.get(r);
    const chosen = [];
    let cost = 0;
    for (const h of r.hits) {
      const blocks = contextBlocks(lines, [...chosen, h], context);
      const next = blocks.reduce((n, b) => n + b.lines.length, 0);
      // 第一筆一定附，之後的要放得進剩下的額度
      if (expanded > 0 && next > budget) break;
      chosen.push(h);
      h.expanded = true;
      r.blocks = blocks;
      cost = next;
      expanded++;
    }
    budget -= cost;
    if (budget <= 0) break;
  }
  const collapsed = context > 0 ? shown.reduce((n, r) => n + r.hits.filter((h) => !h.expanded).length, 0) : 0;
  return { results: out, total: out.length, totalHits, literal, context, auto, expanded, collapsed };
}

/** 讀出知識庫裡要比對的檔案內容。不是 UTF-8 文字的檔案略過。 */
export function readFilesForGrep(root, relPaths) {
  const files = [];
  for (const rel of relPaths) {
    const abs = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    const f = readTextFile(abs);
    if (f.ok) files.push({ path: rel, text: f.text });
  }
  return files;
}

/**
 * 在另一個行程執行 grepLines，超過時間上限就中止。
 * @param {{ kb: string|null, files: { path: string, text: string }[] }[]} sources
 * @param {string} pattern
 * @param {{ context?: number|null, offset?: number, limit?: number }} [opts] 同 grepLines
 * @returns {{ ok: true, results: object[], total: number, totalHits: number, literal: boolean, context: number, auto: boolean, expanded: number, collapsed: number } | { ok: false, reason: 'timeout'|'failed', message: string }}
 */
export function grepSearch(sources, pattern, opts = {}) {
  const r = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify({ sources, pattern, opts }),
    encoding: 'utf8',
    timeout: LIMITS.grepTimeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { ok: false, reason: 'timeout', message: `比對超過 ${LIMITS.grepTimeoutMs / 1000} 秒` };
  if (r.error || r.status !== 0) return { ok: false, reason: 'failed', message: r.error?.message ?? (r.stderr.trim().split('\n').pop() || '未知錯誤') };
  return { ok: true, ...JSON.parse(r.stdout) };
}

/**
 * 把一個檔案的命中結果排成給人或模型看的幾行文字。
 * @param {{ hits: object[], blocks: object[] }} result grepLines 回傳的其中一筆
 * @returns {string[]}
 */
export function formatGrepHits(result) {
  const out = [];
  for (const b of result.blocks) {
    out.push(`   L${b.lines[0].line}-L${b.lines.at(-1).line}，命中 ${b.hits.map((h) => `L${h.line}${h.where ? `（${h.where}）` : ''}`).join('、')}:`);
    for (const l of b.lines) out.push(`   ${l.hit ? '>' : ' '} ${String(l.line).padStart(5)}  ${l.text}`);
  }
  for (const h of result.hits.filter((x) => !x.expanded)) out.push(`   L${h.line}${h.where ? `（${h.where}）` : ''}: ${h.text}`);
  return out;
}

/** 把使用者或模型給的 context 轉成 grepLines 要的值：沒給或不是數字時回傳 null（自動決定）。 */
export function parseContext(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 結果後面的說明：前後文是怎麼決定的、哪些沒有附、接下來可以怎麼做。沒有要說明的回傳空陣列。
 * @param {object} found grepLines 的結果
 * @param {{ contextArg: string, narrow: string }} how contextArg：加上前後文的寫法；narrow：縮小範圍的做法
 */
export function grepAdvice(found, { contextArg, narrow }) {
  if (found.context === 0 && found.auto) {
    return [`共命中 ${found.totalHits} 行，超過 ${LIMITS.grepAutoContextMaxHits} 行，所以只列出每一行。下一步（擇一）：把樣式改得更精確（加上前後的字，或用 ^、\\b 限定），命中 ${LIMITS.grepAutoContextMaxHits} 行以內時會自動附上前後各 ${LIMITS.grepAutoContext} 行；或${contextArg}，看前幾筆的前後文（看附近幾行用 3，看整個函式用 20 到 40，最多 ${LIMITS.grepMaxContext}）。`];
  }
  if (found.collapsed > 0) {
    return [`前後文的總量上限是 ${LIMITS.grepContextBudgetLines} 行，只有前 ${found.expanded} 筆附上前後文（> 標示命中的行），其餘 ${found.collapsed} 筆只列出那一行。下一步：把樣式改得更精確，${narrow}，讓命中的筆數變少。`];
  }
  return found.context > 0 ? [`已附上命中行前後各 ${found.context} 行，> 標示命中的行。`] : [];
}
