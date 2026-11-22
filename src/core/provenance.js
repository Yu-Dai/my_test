// provenance.json（定死）：來源與頁面的對應表。
//
// {
//   "schema_version": 1,
//   "sources": {
//     "raw/uart-spec.md": {
//       "hash": "sha256:…",              最近一次 ingest 時的來源內容 hash
//       "pages": ["uart/baud-rate", …],  目前受這份來源影響的頁面（引用它，或由它的 ingest 產生／修改，且仍存在）
//       "ingests": [                      歷次 ingest，舊到新
//         { "id": "20261123-153000-ab12", "date": "2026-11-23", "hash": "sha256:…",
//           "created": [...], "updated": [...], "deleted": [...] }
//       ]
//     }
//   }
// }
//
// ingest 的 commit 訊息帶同一個 id：`ingest: raw/uart-spec.md [20261123-153000-ab12]`，
// 用 `git log --grep <id>` 可找到對應的 commit（commit 無法在自己的內容裡記錄自己的 hash）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './constants.js';

export const PROVENANCE_PATH = '.kb/provenance.json';

export function hashFile(absPath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')}`;
}

export function emptyProvenance() {
  return { schema_version: SCHEMA_VERSION, sources: {} };
}

export function readProvenance(root) {
  const abs = path.join(root, ...PROVENANCE_PATH.split('/'));
  if (!fs.existsSync(abs)) return emptyProvenance();
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  data.sources ??= {};
  return data;
}

export function serializeProvenance(prov) {
  const sources = {};
  for (const key of Object.keys(prov.sources).sort()) sources[key] = prov.sources[key];
  return `${JSON.stringify({ schema_version: prov.schema_version, sources }, null, 2)}\n`;
}

export function writeProvenance(root, prov) {
  fs.mkdirSync(path.join(root, '.kb'), { recursive: true });
  fs.writeFileSync(path.join(root, ...PROVENANCE_PATH.split('/')), serializeProvenance(prov));
}

/**
 * 記錄一次 ingest，並依目前的頁面重新計算每份來源的 pages。
 * @param {object} prov
 * @param {{ id: string, date: string, source: string, hash: string, created: string[], updated: string[], deleted: string[] }} ingest
 * @param {Map<string, object>} pages 目前知識庫的全部頁面
 */
export function recordIngest(prov, ingest, pages) {
  const entry = (prov.sources[ingest.source] ??= { hash: ingest.hash, pages: [], ingests: [] });
  entry.hash = ingest.hash;
  entry.ingests.push({ id: ingest.id, date: ingest.date, hash: ingest.hash, created: ingest.created, updated: ingest.updated, deleted: ingest.deleted });
  return refreshPages(prov, pages);
}

/** 依目前的頁面重新計算每份來源的 pages。 */
export function refreshPages(prov, pages) {
  for (const [source, e] of Object.entries(prov.sources)) {
    const set = new Set();
    for (const p of pages.values()) if (p.sources.some((s) => s.path === source)) set.add(p.id);
    for (const ing of e.ingests) for (const id of [...ing.created, ...ing.updated]) if (pages.has(id)) set.add(id);
    e.pages = [...set].sort();
  }
  return prov;
}

/**
 * 尚未 ingest，或 ingest 之後內容有變的來源。
 * @returns {{ path: string, state: 'new'|'changed' }[]}
 */
export function pendingSources(root, rawFiles, prov) {
  const out = [];
  for (const rel of rawFiles) {
    const e = prov.sources[rel];
    if (!e) out.push({ path: rel, state: 'new' });
    else if (e.hash !== hashFile(path.join(root, ...rel.split('/')))) out.push({ path: rel, state: 'changed' });
  }
  return out;
}
