// index.md 與 .kb/search-index.json 的產生。輸出完全由頁面內容決定（不含時間戳），
// 所以可以用「重新產生後比對」判斷是否過期。

import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './constants.js';
import { sortedPages } from './kb.js';

export const INDEX_PATH = 'index.md';
export const SEARCH_INDEX_PATH = '.kb/search-index.json';

export function renderIndex(kb) {
  const out = [];
  out.push(`# ${kb.meta?.title ?? '知識庫'} 目錄`, '');
  out.push('> 此檔由 `kb rebuild` 產生，請勿手動修改。', '');
  const byCat = new Map();
  for (const p of sortedPages(kb)) {
    const cat = p.id.split('/')[0];
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(p);
  }
  for (const [cat, pages] of byCat) {
    out.push(`## ${cat}`, '');
    for (const p of pages) out.push(`- [[${p.id}]] ${p.title} — ${p.summary}`);
    out.push('');
  }
  return out.join('\n');
}

export function buildSearchIndex(kb) {
  return {
    schema_version: SCHEMA_VERSION,
    kb: kb.meta?.name ?? null,
    pages: sortedPages(kb).map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      summary: p.summary,
      keywords: p.keywords,
      aliases: p.aliases,
      updated: p.updated,
      body: p.body,
    })),
  };
}

/** 每頁一行，git diff 才看得懂。 */
export function serializeSearchIndex(index) {
  const head = `{"schema_version":${JSON.stringify(index.schema_version)},"kb":${JSON.stringify(index.kb)},"pages":[`;
  const rows = index.pages.map((p) => JSON.stringify(p));
  return `${head}\n${rows.join(',\n')}\n]}\n`;
}

/** 寫出 index.md 與搜尋索引，回傳寫了哪些檔案。 */
export function writeIndexes(kb) {
  fs.mkdirSync(path.join(kb.root, '.kb'), { recursive: true });
  fs.writeFileSync(path.join(kb.root, INDEX_PATH), renderIndex(kb));
  fs.writeFileSync(path.join(kb.root, ...SEARCH_INDEX_PATH.split('/')), serializeSearchIndex(buildSearchIndex(kb)));
  return [INDEX_PATH, SEARCH_INDEX_PATH];
}

/** 比對磁碟上的索引是否與目前頁面一致，回傳過期的檔案清單。 */
export function staleIndexes(kb) {
  const want = {
    [INDEX_PATH]: renderIndex(kb),
    [SEARCH_INDEX_PATH]: serializeSearchIndex(buildSearchIndex(kb)),
  };
  const stale = [];
  for (const [rel, content] of Object.entries(want)) {
    const abs = path.join(kb.root, ...rel.split('/'));
    const have = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : null;
    if (have !== content) stale.push(rel);
  }
  return stale;
}

/** 讀取磁碟上的搜尋索引。不存在或壞掉回傳 null。 */
export function readSearchIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ...SEARCH_INDEX_PATH.split('/')), 'utf8'));
  } catch {
    return null;
  }
}
