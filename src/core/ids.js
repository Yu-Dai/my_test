import { SLUG_RE } from './constants.js';

/** 頁面代號 `分類/名稱` → { category, name }，不合法回傳 null。 */
export function parsePageId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split('/');
  if (parts.length !== 2) return null;
  const [category, name] = parts;
  if (!SLUG_RE.test(category) || !SLUG_RE.test(name)) return null;
  return { category, name };
}

export function pageIdToPath(id) {
  return `wiki/${id}.md`;
}

/** `wiki/分類/名稱.md` → 頁面代號，不符合命名規則回傳 null。 */
export function pathToPageId(relPath) {
  const m = /^wiki\/([^/]+)\/([^/]+)\.md$/.exec(relPath);
  if (!m) return null;
  const id = `${m[1]}/${m[2]}`;
  return parsePageId(id) ? id : null;
}

/**
 * 解析 `[[...]]` 內的文字。
 * 接受：分類/名稱、分類/名稱|顯示文字、知識庫代號:分類/名稱、知識庫代號:分類/名稱|顯示文字
 * @returns {{ ok: true, kb: string|null, id: string, text: string|null } | { ok: false, reason: string }}
 */
export function parseLinkTarget(inner) {
  const bar = inner.indexOf('|');
  const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const text = bar === -1 ? null : inner.slice(bar + 1).trim();
  if (bar !== -1 && !text) return { ok: false, reason: '「|」後面的顯示文字是空的' };

  let kb = null;
  let id = target;
  const colon = target.indexOf(':');
  if (colon !== -1) {
    kb = target.slice(0, colon);
    id = target.slice(colon + 1);
    if (!SLUG_RE.test(kb)) return { ok: false, reason: `知識庫代號「${kb}」不合法（只能用小寫英數加連字號）` };
  }
  if (!parsePageId(id)) {
    return { ok: false, reason: `頁面代號「${id}」不合法（必須是 分類/名稱，都用小寫英數加連字號，不含 .md 與 wiki/）` };
  }
  return { ok: true, kb, id, text };
}
