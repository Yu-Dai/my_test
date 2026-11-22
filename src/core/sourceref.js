// 來源引用（定死）：
//   raw/<路徑>#<章節編號或標題>       只用於 markdown 來源；標題可含或不含編號，取第一個符合的
//   raw/<路徑>:L<起>-L<迄>           任何文字檔；單行可寫 :L<行>
// 一律要帶位置，不接受只有檔名。

import fs from 'node:fs';
import path from 'node:path';
import { MARKDOWN_EXTENSIONS } from './constants.js';
import { listHeadings } from './markdown.js';
import { normalizeText, readTextFile, splitLines } from './text.js';

export const SOURCE_REF_EXAMPLES = 'raw/spec.md#3.2 或 raw/spec.md#安裝步驟 或 raw/drv.c:L120-L180';

/**
 * 只檢查寫法，不碰檔案。
 * @returns {{ ok: true, path: string, kind: 'section', anchor: string } | { ok: true, path: string, kind: 'lines', start: number, end: number } | { ok: false, reason: string }}
 */
export function parseSourceRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, reason: '來源引用是空的' };
  ref = ref.trim();
  if (ref.includes('\\')) return { ok: false, reason: '路徑要用 / 分隔，不要用 \\' };
  if (!ref.startsWith('raw/')) return { ok: false, reason: '來源引用必須從知識庫根目錄寫起，以 raw/ 開頭' };

  let parsed;
  const lm = /^(raw\/.+):L(\d+)(?:-L(\d+))?$/.exec(ref);
  const sm = /^(raw\/[^#]+)#(.+)$/.exec(ref);
  if (lm) {
    const start = Number(lm[2]);
    const end = lm[3] === undefined ? start : Number(lm[3]);
    if (start < 1) return { ok: false, reason: '行數從 1 起算' };
    if (end < start) return { ok: false, reason: `行數範圍顛倒：L${start}-L${end}` };
    parsed = { ok: true, path: lm[1], kind: 'lines', start, end };
  } else if (sm) {
    parsed = { ok: true, path: sm[1], kind: 'section', anchor: sm[2].trim() };
  } else {
    return { ok: false, reason: '來源引用沒有寫到位置：markdown 來源加 #章節，其他檔案加 :L起-L迄' };
  }
  if (parsed.path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return { ok: false, reason: '路徑不可包含 .. 或 . 或空的層級' };
  }
  return parsed;
}

/** 標題開頭的章節編號，例如「3.2 暫存器」→「3.2」。沒有編號回傳 null。 */
export function headingNumber(text) {
  const m = /^(\d+(?:\.\d+)*)\.?(?=\s|$)/.exec(text.normalize('NFKC'));
  return m ? m[1] : null;
}

function findHeading(headings, anchor) {
  const want = normalizeText(anchor).replace(/\.$/, '');
  const full = normalizeText(anchor);
  return headings.findIndex((h) => {
    const text = normalizeText(h.text);
    if (text === full) return true;
    const num = headingNumber(h.text);
    if (num === null) return false;
    // 章節編號，或去掉編號後的標題文字
    return num === want || text.replace(/^\d+(?:\.\d+)*\.?\s+/, '') === full;
  });
}

/**
 * 解析並對照實際檔案，算出行數範圍。
 * @returns {{ ok: true, path: string, startLine: number, endLine: number, heading: string|null, lines: string[] } | { ok: false, reason: string, hint?: string }}
 */
export function resolveSourceRef(kbRoot, ref) {
  const p = parseSourceRef(ref);
  if (!p.ok) return p;
  const abs = path.join(kbRoot, ...p.path.split('/'));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, reason: `找不到來源檔 ${p.path}`, hint: '確認檔名大小寫與路徑，來源檔必須放在 raw/ 底下' };
  }
  const file = readTextFile(abs);
  if (!file.ok) return { ok: false, reason: `${p.path} 不是 UTF-8 文字檔，無法引用` };
  const lines = splitLines(file.text);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  if (p.kind === 'lines') {
    if (p.end > lines.length) {
      return { ok: false, reason: `${p.path} 只有 ${lines.length} 行，引用的 L${p.start}-L${p.end} 超出範圍` };
    }
    return { ok: true, path: p.path, startLine: p.start, endLine: p.end, heading: null, lines: lines.slice(p.start - 1, p.end) };
  }

  const ext = path.extname(p.path).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: `#章節 只能用在 markdown 來源，${p.path} 請改用行數`, hint: `例如 ${p.path}:L1-L${Math.min(lines.length, 40)}` };
  }
  const headings = listHeadings(lines);
  const idx = findHeading(headings, p.anchor);
  if (idx === -1) {
    const avail = headings.slice(0, 15).map((h) => `「${h.text}」`).join('、');
    return {
      ok: false,
      reason: `${p.path} 裡找不到章節「${p.anchor}」`,
      hint: headings.length ? `可用的章節：${avail}${headings.length > 15 ? ' …' : ''}（寫章節編號或完整標題）` : `這份來源沒有標題，請改用行數，例如 ${p.path}:L1-L${Math.min(lines.length, 40)}`,
    };
  }
  const h = headings[idx];
  const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
  const endLine = next ? next.line - 1 : lines.length;
  return { ok: true, path: p.path, startLine: h.line, endLine, heading: h.text, lines: lines.slice(h.line - 1, endLine) };
}
