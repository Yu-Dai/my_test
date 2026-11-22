// 關鍵字搜尋：沒有 embedding，靠正規化後的子字串比對。
// 排序：標題、keywords、aliases 命中在前，其次 summary，最後內文。

import { LIMITS } from './constants.js';
import { normalizeText } from './text.js';

const WEIGHT = { titleExact: 15, title: 10, tagExact: 12, tag: 8, summary: 4, body: 1 };

function snippet(body, term) {
  // 優先取內文行，標題行排最後
  const lines = body.split('\n');
  const ordered = [...lines.filter((l) => !/^#{1,6}\s/.test(l)), ...lines.filter((l) => /^#{1,6}\s/.test(l))];
  for (const line of ordered) {
    const norm = normalizeText(line);
    const at = norm.indexOf(term);
    if (at === -1) continue;
    const text = line.trim();
    if (text.length <= LIMITS.snippetChars) return text;
    const start = Math.max(0, Math.min(at - 30, text.length - LIMITS.snippetChars));
    return `${start > 0 ? '…' : ''}${text.slice(start, start + LIMITS.snippetChars)}${start + LIMITS.snippetChars < text.length ? '…' : ''}`;
  }
  return null;
}

function scorePage(page, terms) {
  const title = normalizeText(page.title);
  const tags = [...page.keywords, ...page.aliases].map(normalizeText);
  const summary = normalizeText(page.summary);
  const body = normalizeText(page.body);
  let score = 0;
  const matched = [];
  const where = new Set();
  let snip = null;
  for (const term of terms) {
    let s = 0;
    if (title === term) { s += WEIGHT.titleExact; where.add('title'); }
    else if (title.includes(term)) { s += WEIGHT.title; where.add('title'); }
    if (tags.includes(term)) { s += WEIGHT.tagExact; where.add('keywords'); }
    else if (tags.some((t) => t.includes(term))) { s += WEIGHT.tag; where.add('keywords'); }
    if (summary.includes(term)) { s += WEIGHT.summary; where.add('summary'); }
    if (body.includes(term)) {
      const count = Math.min(body.split(term).length - 1, 5);
      s += WEIGHT.body + count * 0.2;
      where.add('body');
      snip ??= snippet(page.body, term);
    }
    if (s > 0) { score += s; matched.push(term); }
  }
  return { score, matched, where: [...where], snippet: snip };
}

function clip(line, at) {
  const text = line.trim();
  if (text.length <= LIMITS.snippetChars) return text;
  const start = Math.max(0, Math.min(at - 30, text.length - LIMITS.snippetChars));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + LIMITS.snippetChars)}${start + LIMITS.snippetChars < text.length ? '…' : ''}`;
}

/**
 * 搜尋 raw 檔案的內容，以檔案為單位回傳，命中行數多的排前面。
 * @param {{ kb: string|null, files: { path: string, text: string }[] }[]} sources
 * @param {string[]} terms
 * @param {{ limit?: number }} [opts]
 * @returns {{ results: { kb: string|null, path: string, hitCount: number, hits: { line: number, text: string }[] }[], total: number }}
 */
export function searchRaw(sources, terms, opts = {}) {
  const limit = opts.limit ?? LIMITS.searchDefaultLimit;
  const norm = [...new Set(terms.map((t) => normalizeText(t).trim()).filter(Boolean))];
  const out = [];
  for (const src of sources) {
    for (const file of src.files) {
      const hits = [];
      let hitCount = 0;
      const nameHit = norm.some((t) => normalizeText(file.path).includes(t));
      file.text.split(/\r?\n/).forEach((line, i) => {
        const n = normalizeText(line);
        const term = norm.find((t) => n.includes(t));
        if (!term) return;
        hitCount++;
        if (hits.length < LIMITS.rawHitsPerFile) hits.push({ line: i + 1, text: clip(line, n.indexOf(term)) });
      });
      if (hitCount > 0 || nameHit) out.push({ kb: src.kb, path: file.path, hitCount, hits, nameHit });
    }
  }
  out.sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || b.hitCount - a.hitCount || (a.path < b.path ? -1 : 1));
  return { results: out.slice(0, limit), total: out.length };
}

/**
 * @param {{ kb: string|null, pages: object[] }[]} indexes 一個或多個知識庫的搜尋索引
 * @param {string[]} terms 關鍵字，任一命中即算
 * @param {{ limit?: number }} [opts]
 * @returns {{ results: object[], total: number, terms: string[] }}
 */
export function searchWiki(indexes, terms, opts = {}) {
  const limit = opts.limit ?? LIMITS.searchDefaultLimit;
  const norm = [...new Set(terms.map((t) => normalizeText(t).trim()).filter(Boolean))];
  const hits = [];
  for (const index of indexes) {
    for (const page of index.pages) {
      const r = scorePage(page, norm);
      if (r.score > 0) {
        hits.push({ kb: index.kb, id: page.id, title: page.title, summary: page.summary, score: Math.round(r.score * 10) / 10, matched: r.matched, where: r.where, snippet: r.snippet });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || (`${a.kb}:${a.id}` < `${b.kb}:${b.id}` ? -1 : 1));
  return { results: hits.slice(0, limit), total: hits.length, terms: norm };
}
