import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE_KB = path.join(REPO_ROOT, 'examples', 'sample-kb');
export const CLI = path.join(REPO_ROOT, 'src', 'cli', 'kb.js');

export const KB_JSON = {
  name: 'test-kb',
  title: '測試知識庫',
  description: '測試用',
  owner: 'tester',
  category: 'test',
  schema_version: 1,
  confidentiality: 'public',
};

export const RAW_SPEC = ['# 規格', '', '## 1 概觀', '', '概觀內容', '', '## 2 細節', '', '### 2.1 暫存器', '', '暫存器內容', '', '## 附錄', '', '附錄內容', ''].join('\n');
export const RAW_CODE = ['int a;', 'int b;', 'int c;', 'int d;', 'int e;', ''].join('\n');

/** 組出一個頁面。fm 覆寫開頭欄位（值為 undefined 表示刪掉該欄位），body 覆寫內文。 */
export function makePage(fm = {}, body) {
  const base = {
    title: '測試頁',
    type: 'concept',
    summary: '一句話摘要',
    keywords: '[測試, test]',
    aliases: '[別名]',
    sources: '\n  - raw/spec.md#2.1\n  - raw/code.c:L2-L4',
    updated: '2026-11-22',
    ...fm,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(base)) if (v !== undefined) lines.push(`${k}: ${v}`.replace(': \n', ':\n'));
  lines.push('---', '');
  lines.push(body ?? '## 內容\n\n內文。\n\n## 相關頁面\n\n- 無\n\n## 來源\n\n- raw/spec.md#2.1\n');
  return lines.join('\n');
}

/** 建立暫存知識庫。files 是 { 相對路徑: 內容 }，會蓋掉預設檔案。 */
export function makeKb(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-test-'));
  const all = {
    'kb.json': JSON.stringify(KB_JSON, null, 2),
    'raw/spec.md': RAW_SPEC,
    'raw/code.c': RAW_CODE,
    'assets/pic.png': 'PNG',
    'wiki/topic/alpha.md': makePage(),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export function codes(issues, level = 'error') {
  return issues.filter((i) => i.level === level).map((i) => i.code);
}
