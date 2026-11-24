// grep 搜尋：用樣式（regex）逐行比對，回傳命中的行。與關鍵字搜尋互補，適合找函式名、暫存器位址、錯誤碼這類有固定格式的東西。
//
// 寫壞的樣式可能讓比對跑非常久，所以比對在另一個行程執行並設時間上限，逾時就中止，不會卡住呼叫端。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './constants.js';
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

/**
 * 逐行比對。以檔案為單位回傳，命中行數多的排前面。全形與半形視為相同。
 * @param {{ kb: string|null, files: { path: string, text: string }[] }[]} sources
 * @param {string} pattern
 * @returns {{ results: { kb: string|null, path: string, hitCount: number, hits: { line: number, text: string }[] }[], total: number, literal: boolean }}
 */
export function grepLines(sources, pattern) {
  const { re, literal } = compilePattern(pattern);
  const out = [];
  for (const src of sources) {
    for (const file of src.files) {
      const hits = [];
      let hitCount = 0;
      file.text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.length > LIMITS.grepMaxLineChars ? raw.slice(0, LIMITS.grepMaxLineChars) : raw;
        const m = re.exec(line) ?? re.exec(line.normalize('NFKC'));
        if (!m) return;
        hitCount++;
        if (hits.length < LIMITS.grepHitsPerFile) hits.push({ line: i + 1, text: clip(line, m.index) });
      });
      if (hitCount > 0) out.push({ kb: src.kb, path: file.path, hitCount, hits });
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
 * @returns {{ ok: true, results: object[], total: number, literal: boolean } | { ok: false, reason: 'timeout'|'failed', message: string }}
 */
export function grepSearch(sources, pattern) {
  const r = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify({ sources, pattern }),
    encoding: 'utf8',
    timeout: LIMITS.grepTimeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { ok: false, reason: 'timeout', message: `比對超過 ${LIMITS.grepTimeoutMs / 1000} 秒` };
  if (r.error || r.status !== 0) return { ok: false, reason: 'failed', message: r.error?.message ?? (r.stderr.trim().split('\n').pop() || '未知錯誤') };
  return { ok: true, ...JSON.parse(r.stdout) };
}
