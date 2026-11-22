import fs from 'node:fs';

/** 搜尋與比對用的正規化：全形半形視為相同、不分大小寫。 */
export function normalizeText(s) {
  return String(s).normalize('NFKC').toLowerCase();
}

export function splitLines(text) {
  return text.split(/\r?\n/);
}

/**
 * 讀取文字檔並回報編碼狀況。
 * @returns {{ ok: boolean, text: string, binary: boolean, validUtf8: boolean, hasBom: boolean, hasCrlf: boolean }}
 */
export function readTextFile(absPath) {
  const buf = fs.readFileSync(absPath);
  const binary = buf.includes(0);
  let text = '';
  let validUtf8 = true;
  if (!binary) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      validUtf8 = false;
    }
  }
  const hasBom = text.charCodeAt(0) === 0xfeff;
  if (hasBom) text = text.slice(1);
  return {
    ok: !binary && validUtf8,
    text,
    binary,
    validUtf8: !binary && validUtf8,
    hasBom,
    hasCrlf: text.includes('\r\n'),
  };
}

/** 把路徑統一成以 / 分隔。 */
export function toPosix(p) {
  return p.split('\\').join('/');
}
