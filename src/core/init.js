// kb init：建立知識庫資料夾結構與 git repo。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './constants.js';
import { git, hasIdentity } from './git.js';
import { writeIndexes } from './indexgen.js';
import { loadKb } from './kb.js';
import { validateKbJson } from './kbjson.js';
import { emptyProvenance, writeProvenance } from './provenance.js';

export const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const LOG_PATH = 'log.md';
export const STATE_PATH = '.kb/ingest-state.json';
const INIT_FIELDS = ['name', 'title', 'description', 'owner', 'category', 'confidentiality'];

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function appendLog(root, heading, lines = []) {
  const abs = path.join(root, LOG_PATH);
  const head = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '\n') : '# 操作紀錄\n\n> 此檔由 kb 指令附加，請勿手動修改。\n';
  fs.writeFileSync(abs, `${head}\n## [${today()}] ${heading}\n${lines.length ? `\n${lines.join('\n')}\n` : ''}`);
}

const INIT_EXAMPLE = 'kb init D:/kb/uart-driver --name uart-driver --title "UART 驅動程式知識庫" --description "示範板 UART 的規格與驅動程式" --owner firmware-team --category driver --confidentiality internal';

/**
 * @param {string} dir 要建立的知識庫資料夾（不存在或是空的）
 * @param {object} fields name、title、description、owner、category、confidentiality
 * @returns {{ code: number, text: string }}
 */
export function initKb(dir, fields) {
  const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}\n  下一步：${next}` });
  if (!dir) return fail('沒有指定要建立知識庫的資料夾', `向使用者問清楚各欄位後執行：\n    ${INIT_EXAMPLE}`);
  const root = path.resolve(dir);

  const missing = INIT_FIELDS.filter((k) => typeof fields[k] !== 'string' || !fields[k].trim());
  if (missing.length) {
    return fail(`缺少欄位：${missing.map((k) => `--${k}`).join('、')}`, `向使用者問清楚這些欄位（不要自己編），再執行一次。完整範例：\n    ${INIT_EXAMPLE}\n    name 與 category 只能用小寫英數加連字號。`);
  }
  const meta = { ...Object.fromEntries(INIT_FIELDS.slice(0, 5).map((k) => [k, fields[k].trim()])), schema_version: SCHEMA_VERSION, confidentiality: fields.confidentiality.trim() };
  const check = validateKbJson(JSON.stringify(meta));
  if (check.issues.length) {
    return fail(check.issues.map((i) => `${i.message}（正確寫法：${i.example}）`).join('；'), '修正欄位後再執行一次 kb init');
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    return fail(`${root} 已經存在而且不是空的`, '換一個新的資料夾路徑；kb init 不會覆蓋既有內容');
  }
  if (!hasIdentity(process.cwd())) {
    return fail('git 還沒設定使用者名稱與信箱，無法建立 commit', '請使用者先執行：git config --global user.name "姓名" 與 git config --global user.email "信箱"');
  }

  const write = (rel, content) => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('kb.json', `${JSON.stringify(meta, null, 2)}\n`);
  const schema = fs.readFileSync(path.join(TEMPLATE_DIR, 'SCHEMA.md'), 'utf8').replace(/\r\n/g, '\n');
  write('SCHEMA.md', schema.replace(/\{\{(\w+)\}\}/g, (_, k) => meta[k] ?? ''));
  for (const d of ['raw', 'wiki', 'assets']) write(`${d}/.gitkeep`, '');
  write('.gitattributes', '# 不讓 git 轉換換行：行數引用與來源 hash 依賴原始位元組\n* -text\n');
  write('.gitignore', `${STATE_PATH}\n`);
  write('.kb/query-tests.json', `${JSON.stringify({ schema_version: SCHEMA_VERSION, tests: [] }, null, 2)}\n`);
  writeProvenance(root, emptyProvenance());
  appendLog(root, `init | ${meta.name}`);
  writeIndexes(loadKb(root));

  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', `init: ${meta.name}`]]) {
    const r = git(root, args);
    if (!r.ok) return fail(`git ${args[0]} 失敗：${r.stderr}`, `資料夾已建立在 ${root}，請排除 git 問題後在該資料夾手動執行 git add -A 與 git commit`);
  }
  return {
    code: 0,
    text: [
      `已建立知識庫 ${meta.name}：${root}`,
      '',
      '下一步：',
      `1. 請維護者看一下 ${path.join(root, 'SCHEMA.md')}，補上分類方式與領域用語（可以之後再補）。`,
      '2. 把來源文字檔放進 raw/。PDF、Office 檔要先轉成 markdown。',
      `3. 切換到 ${root}，執行：kb ingest start`,
    ].join('\n'),
  };
}
