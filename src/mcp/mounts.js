// 已掛載的知識庫。只讀：不寫入任何知識庫的檔案（共享知識庫的本機快取除外，那是可丟棄的複本）。

import fs from 'node:fs';
import path from 'node:path';
import { CONFIDENTIALITY_LEVELS, DEFAULT_MAX_CONFIDENTIALITY, buildSearchIndex, loadKb, readTextFile, sortedPages } from '../core/index.js';
import { cachePathFor, readSyncInfo, syncRemote } from './cache.js';
import { KB_CLI, defaultCacheDir } from './config.js';

function stamp(root) {
  // 知識庫的任何寫入（ingest、rebuild、快取更新）都會更新這幾個檔案
  return ['kb.json', 'index.md', '.kb/search-index.json']
    .map((rel) => {
      try {
        return fs.statSync(path.join(root, ...rel.split('/'))).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(':');
}

export class Mounts {
  /**
   * @param {(string|{ path?: string, remote?: string })[]} entries 知識庫：本機資料夾，或共享資料夾上的 bare repo
   * @param {string[]} [problems] 設定檔階段就發現的問題
   * @param {{ maxConfidentiality?: string, cacheDir?: string }} [opts]
   */
  constructor(entries, problems = [], opts = {}) {
    this.maxConfidentiality = opts.maxConfidentiality ?? DEFAULT_MAX_CONFIDENTIALITY;
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    this.entries = entries.map((e) => {
      if (typeof e === 'string') return { path: e };
      if (e.remote) return { remote: e.remote, path: cachePathFor(this.cacheDir, e.remote), sync: { state: 'pending', error: null } };
      return { path: e.path };
    });
    this.configProblems = problems;
    this.kbs = new Map(); // name → { name, root, meta, pages, pageList, index, rawFiles, stamp, shared }
    this.problems = [];
    this.reload();
  }

  reload() {
    this.kbs.clear();
    this.problems = [...this.configProblems];
    for (const entry of this.entries) this.#mount(entry);
  }

  #mount(entry) {
    const root = entry.path;
    const label = entry.remote ? `共享知識庫 ${entry.remote}` : root;
    if (entry.remote && !fs.existsSync(path.join(root, '.git'))) {
      if (entry.sync.untrusted) this.problems.push(`${label} 沒有掛載：${entry.sync.error}，然後重新啟動 MCP`);
      else if (entry.sync.state === 'failed') this.problems.push(`${label} 沒有掛載：無法從共享資料夾下載，本機也沒有快取（${entry.sync.error}）。確認共享資料夾連得上、路徑正確，然後重新啟動 MCP`);
      else this.problems.push(`${label} 正在第一次下載到本機快取，稍後再呼叫一次 GetWikiInfo`);
      return;
    }
    if (!fs.existsSync(path.join(root, 'kb.json'))) {
      this.problems.push(`${label} 沒有掛載：找不到 kb.json（路徑錯誤，或這不是知識庫）`);
      return;
    }
    const kb = loadKb(root);
    const metaErrors = kb.issues.filter((i) => i.level === 'error' && i.file === 'kb.json');
    if (!kb.meta || metaErrors.length) {
      this.problems.push(`${label} 沒有掛載：kb.json 不合格（${metaErrors.map((i) => i.message).join('；')}）`);
      return;
    }
    const name = kb.meta.name;
    if (CONFIDENTIALITY_LEVELS.indexOf(kb.meta.confidentiality) > CONFIDENTIALITY_LEVELS.indexOf(this.maxConfidentiality)) {
      this.problems.push(`知識庫 ${name}（${label}）沒有掛載：它的機密等級是 ${kb.meta.confidentiality}，超過這份設定允許的 ${this.maxConfidentiality}。確定這個環境可以使用該等級的資料時，由使用者把設定檔的 max_confidentiality 改成 "${kb.meta.confidentiality}"`);
      return;
    }
    if (this.kbs.has(name)) {
      this.problems.push(`${label} 沒有掛載：知識庫代號「${name}」與 ${this.kbs.get(name).root} 重複`);
      return;
    }
    this.kbs.set(name, {
      name,
      root: kb.root,
      meta: kb.meta,
      pages: kb.pages,
      pageList: sortedPages(kb),
      index: buildSearchIndex(kb),
      rawFiles: kb.rawFiles,
      stamp: stamp(root),
      shared: entry.remote ? { remote: entry.remote, synced: readSyncInfo(root)?.synced ?? null, state: entry.sync.state, error: entry.sync.error } : null,
    });
  }

  /**
   * 更新所有共享知識庫的本機快取。啟動後在背景執行，不擋住 MCP 連線。
   * 更新失敗（例如離線）時沿用既有快取。
   */
  async syncAll() {
    for (const entry of this.entries.filter((e) => e.remote)) {
      entry.sync = { state: 'syncing', error: null };
      const r = await syncRemote(entry.remote, entry.path);
      // 只用 MCP 的使用者不一定把 kb 加進 PATH，所以給完整的執行方式
      const error = r.untrusted ? `${r.error}。確定這個位置可以信任時，請使用者在終端機執行：node "${KB_CLI}" trust "${entry.remote}"` : r.error;
      entry.sync = r.ok ? { state: 'ok', error: null } : { state: 'failed', error, untrusted: r.untrusted };
      this.reload();
    }
  }

  /** 知識庫內容有變動時重新載入。每次工具呼叫前執行。 */
  refresh() {
    for (const kb of this.kbs.values()) {
      if (stamp(kb.root) !== kb.stamp) {
        this.reload();
        return;
      }
    }
  }

  names() {
    return [...this.kbs.keys()];
  }

  get(name) {
    return this.kbs.get(name) ?? null;
  }

  all() {
    return [...this.kbs.values()];
  }

  /** 讀取某個知識庫的全部 raw 文字檔，供 raw 搜尋用。 */
  rawTexts(kb) {
    const files = [];
    for (const rel of kb.rawFiles) {
      const f = readTextFile(path.join(kb.root, ...rel.split('/')));
      if (f.ok) files.push({ path: rel, text: f.text });
    }
    return files;
  }
}
