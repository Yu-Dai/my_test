// 載入整個知識庫：kb.json、所有頁面、raw 檔案清單。

import fs from 'node:fs';
import path from 'node:path';
import { CONVERT_FIRST_EXTENSIONS, IMAGE_EXTENSIONS } from './constants.js';
import { pathToPageId } from './ids.js';
import { KB_JSON_EXAMPLE, validateKbJson } from './kbjson.js';
import { validatePage } from './page.js';
import { readTextFile, toPosix } from './text.js';

/** 從 start 往上找含 kb.json 的資料夾。找不到回傳 null。 */
export function findKbRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'kb.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 遞迴列出資料夾內的檔案，回傳相對於 root 的 posix 路徑（已排序）。 */
export function listFiles(root, sub) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue; // .gitkeep 之類
      const childRel = path.join(rel, ent.name);
      if (ent.isDirectory()) walk(childRel);
      else if (ent.isFile()) out.push(toPosix(childRel));
    }
  };
  walk(sub);
  return out.sort();
}

/**
 * 載入並驗證知識庫。
 * @param {string} root
 * @param {{ draftPaths?: Set<string> }} [opts] draftPaths：這些頁面以草稿模式驗證（不要求 updated）
 * @returns {{ root: string, meta: object|null, pages: Map<string, object>, rawFiles: string[], rawImages: string[], issues: object[] }}
 */
export function loadKb(root, opts = {}) {
  root = path.resolve(root);
  const issues = [];
  const err = (code, file, message, example, next = '修正後執行：kb check') => issues.push({ level: 'error', code, file, line: null, message, example, next });
  const warn = (code, file, message, example, next = '修正後執行：kb check') => issues.push({ level: 'warn', code, file, line: null, message, example, next });

  // kb.json
  let meta = null;
  const kbJsonPath = path.join(root, 'kb.json');
  if (!fs.existsSync(kbJsonPath)) {
    err('kbjson-missing', 'kb.json', `${root} 不是知識庫：找不到 kb.json`, KB_JSON_EXAMPLE);
  } else {
    const r = validateKbJson(fs.readFileSync(kbJsonPath, 'utf8'));
    meta = r.meta;
    issues.push(...r.issues);
  }

  for (const dir of ['raw', 'wiki', 'assets']) {
    if (!fs.existsSync(path.join(root, dir))) warn('dir-missing', `${dir}/`, `缺少資料夾 ${dir}/`, `建立空的 ${dir}/ 資料夾`);
  }

  // raw/
  // 圖片是轉檔工具連同 .md 一起輸出的，不算來源：處理引用它的 .md 時由 ingest 搬到 assets/
  const rawAll = listFiles(root, 'raw');
  const rawImages = rawAll.filter((rel) => IMAGE_EXTENSIONS.includes(path.extname(rel).toLowerCase()));
  const rawFiles = rawAll.filter((rel) => !rawImages.includes(rel));
  for (const rel of rawFiles) {
    const ext = path.extname(rel).toLowerCase();
    if (CONVERT_FIRST_EXTENSIONS.includes(ext)) {
      err('raw-ext', rel, `raw/ 只收文字檔，「${ext}」要先轉檔`, 'PDF、Office 檔請先轉成 .md，把 .md 與圖片資料夾一起放進 raw/');
      continue;
    }
    const f = readTextFile(path.join(root, rel));
    if (f.binary) err('raw-binary', rel, '這個檔案是二進位內容，不是文字檔', '文件請先轉成 .md 再放進 raw/；不是文件的二進位檔（執行檔、壓縮檔、韌體映像）請移出 raw/');
    else if (!f.validUtf8) err('raw-encoding', rel, '這個檔案不是 UTF-8 編碼', '用編輯器另存成 UTF-8（無 BOM）後再放進 raw/');
  }

  // wiki/
  const wikiFiles = listFiles(root, 'wiki');
  const pageFiles = wikiFiles.filter((f) => pathToPageId(f));
  const idSet = new Set(pageFiles.map((f) => pathToPageId(f)));
  const pages = new Map();
  for (const rel of wikiFiles) {
    if (!pathToPageId(rel)) {
      err('page-path', rel, 'wiki/ 內的檔案路徑不合規則', 'wiki/<分類>/<名稱>.md，分類與名稱都用小寫英數加連字號，只能有一層分類');
      continue;
    }
    const f = readTextFile(path.join(root, rel));
    if (!f.ok) {
      err('page-encoding', rel, '頁面不是 UTF-8 文字檔', '另存成 UTF-8（無 BOM）');
      continue;
    }
    if (f.hasBom) warn('page-bom', rel, '頁面開頭有 BOM', '另存成 UTF-8（無 BOM）');
    if (f.hasCrlf) warn('page-crlf', rel, '頁面使用 CRLF 換行', '知識庫內一律用 LF 換行');
    const r = validatePage({ kbRoot: root, relPath: rel, text: f.text, mode: opts.draftPaths?.has(rel) ? 'draft' : 'stored', hasPage: (id) => idSet.has(id) });
    issues.push(...r.issues);
    if (r.page) pages.set(r.page.id, r.page);
  }

  return { root, meta, pages, rawFiles, rawImages, issues };
}

/** 頁面依代號排序後的陣列。 */
export function sortedPages(kb) {
  return [...kb.pages.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
