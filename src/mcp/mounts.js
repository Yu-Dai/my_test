// 已掛載的知識庫。只讀：這裡不寫入任何檔案。

import fs from 'node:fs';
import path from 'node:path';
import { buildSearchIndex, loadKb, readTextFile, sortedPages } from '../core/index.js';

function stamp(root) {
  // 知識庫的任何寫入（ingest、rebuild）都會更新這幾個檔案
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
   * @param {string[]} paths 知識庫資料夾路徑
   * @param {string[]} [problems] 設定檔階段就發現的問題
   */
  constructor(paths, problems = []) {
    this.paths = paths;
    this.configProblems = problems;
    this.kbs = new Map(); // name → { name, root, meta, pages, index, rawFiles, stamp, errorCount }
    this.problems = [];
    this.reload();
  }

  reload() {
    this.kbs.clear();
    this.problems = [...this.configProblems];
    for (const root of this.paths) this.#mount(root);
  }

  #mount(root) {
    if (!fs.existsSync(path.join(root, 'kb.json'))) {
      this.problems.push(`${root} 沒有掛載：找不到 kb.json（路徑錯誤，或這不是知識庫資料夾）`);
      return;
    }
    const kb = loadKb(root);
    const metaErrors = kb.issues.filter((i) => i.level === 'error' && i.file === 'kb.json');
    if (!kb.meta || metaErrors.length) {
      this.problems.push(`${root} 沒有掛載：kb.json 不合格（${metaErrors.map((i) => i.message).join('；')}）`);
      return;
    }
    const name = kb.meta.name;
    if (this.kbs.has(name)) {
      this.problems.push(`${root} 沒有掛載：知識庫代號「${name}」與 ${this.kbs.get(name).root} 重複`);
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
      errorCount: kb.issues.filter((i) => i.level === 'error').length,
    });
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
