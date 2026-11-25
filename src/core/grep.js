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
 * @returns {{ where: string|null, lines: { line: number, text: string, hit: boolean }[] }[]}
 */
function contextBlocks(lines, hits, context) {
  const blocks = [];
  for (const h of hits) {
    const start = Math.max(1, h.line - context);
    const end = Math.min(lines.length, h.line + context);
    const last = blocks.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else blocks.push({ where: h.where, start, end });
  }
  const hitLines = new Set(hits.map((h) => h.line));
  return blocks.map((b) => ({
    where: b.where,
    lines: lines.slice(b.start - 1, b.end).map((text, i) => ({ line: b.start + i, text: cut(text), hit: hitLines.has(b.start + i) })),
  }));
}

/**
 * 逐行比對。以檔案為單位回傳，命中行數多的排前面。全形與半形視為相同。
 * 每個命中行附上它在哪裡：程式碼是所在的函式，markdown 是所在的章節。
 * @param {{ kb: string|null, files: { path: string, text: string }[] }[]} sources
 * @param {string} pattern
 * @param {{ context?: number }} [opts] context：連同命中行前後各幾行一起回傳
 * @returns {{ results: { kb: string|null, path: string, hitCount: number, hits: { line: number, text: string, where: string|null }[], blocks: object[] }[], total: number, literal: boolean }}
 */
export function grepLines(sources, pattern, opts = {}) {
  const { re, literal } = compilePattern(pattern);
  const context = opts.context ?? 0;
  const out = [];
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
      }
      out.push({ kb: src.kb, path: file.path, hitCount, hits, blocks: context > 0 ? contextBlocks(lines, hits, context) : [] });
    }
  }
  out.sort((a, b) => b.hitCount - a.hitCount || (`${a.kb}:${a.path}` < `${b.kb}:${b.path}` ? -1 : 1));
  return { results: out, total: out.length, literal };
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
 * @param {{ context?: number }} [opts]
 * @returns {{ ok: true, results: object[], total: number, literal: boolean } | { ok: false, reason: 'timeout'|'failed', message: string }}
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
  if (result.blocks.length === 0) return result.hits.map((h) => `   L${h.line}${h.where ? `（${h.where}）` : ''}: ${h.text}`);
  const out = [];
  for (const b of result.blocks) {
    out.push(`   L${b.lines[0].line}-L${b.lines.at(-1).line}${b.where ? `（${b.where}）` : ''}:`);
    for (const l of b.lines) out.push(`   ${l.hit ? '>' : ' '} ${String(l.line).padStart(5)}  ${l.text}`);
  }
  return out;
}
