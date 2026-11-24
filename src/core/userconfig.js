// 使用者端的掛載設定檔：位置、讀取、寫入。內容由 kb mount／kb config 指令維護，wiki MCP 啟動時讀取。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEY_MOUNTS = 'knowledge_bases';
// 停用的知識庫另外存放：MCP 只讀 knowledge_bases，搬出去就等於不掛載
export const KEY_DISABLED = 'disabled_knowledge_bases';
export const KEY_MAX_CONFIDENTIALITY = 'max_confidentiality';
export const KEY_CACHE_DIR = 'cache_dir';

export function defaultConfigPath() {
  return path.join(os.homedir(), '.llm-wiki', 'config.json');
}

export function defaultCacheDir(env = process.env) {
  return env.LLM_WIKI_CACHE ?? path.join(os.homedir(), '.llm-wiki', 'cache');
}

/**
 * 設定檔位置（依序）：明確指定的路徑、環境變數 LLM_WIKI_CONFIG、預設位置。
 * @returns {{ file: string, explicit: boolean }} explicit 表示位置是使用者指定的
 */
export function resolveConfigPath(explicitArg, env = process.env) {
  const explicit = explicitArg ?? env.LLM_WIKI_CONFIG;
  return explicit ? { file: path.resolve(explicit), explicit: true } : { file: defaultConfigPath(), explicit: false };
}

/**
 * 寫入設定檔。先寫暫存檔再改名，避免留下寫到一半的檔案。
 * @returns {{ ok: boolean, error: string|null }}
 */
export function saveUserConfig(file, cfg) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 暫存檔所在的路徑本身就不能用（寫入失敗的原因），沒有東西可清
    }
    return { ok: false, error: e.message };
  }
}

/**
 * 讀取設定檔。預設位置沒有檔案時建立空的設定檔；使用者指定的位置沒有檔案時視為路徑打錯，不建立。
 * 既有檔案讀不懂時只回報，不覆寫。
 * @returns {{ ok: true, cfg: object, created: boolean } | { ok: false, message: string, next: string }}
 */
export function openUserConfig({ file, explicit }) {
  if (!fs.existsSync(file)) {
    if (explicit) {
      return { ok: false, message: `找不到設定檔 ${file}`, next: '確認 --config 或環境變數 LLM_WIKI_CONFIG 的路徑是否正確。指定位置的設定檔不會自動建立；不指定時會使用並自動建立預設位置的設定檔' };
    }
    const cfg = { [KEY_MOUNTS]: [] };
    const w = saveUserConfig(file, cfg);
    if (!w.ok) return { ok: false, message: `無法建立設定檔 ${file}：${w.error}`, next: '確認這個資料夾可以寫入' };
    return { ok: true, cfg, created: true };
  }
  const untouched = '這個檔案不會被覆寫。修正內容，或把它改名備份後再執行一次';
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, message: `設定檔 ${file} 無法讀取，或不是合法的 JSON：${e.message}`, next: untouched };
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, message: `設定檔 ${file} 的內容必須是一個物件`, next: untouched };
  }
  for (const key of [KEY_MOUNTS, KEY_DISABLED]) {
    if (cfg[key] !== undefined && !Array.isArray(cfg[key])) return { ok: false, message: `設定檔 ${file} 的 ${key} 必須是清單`, next: untouched };
  }
  return { ok: true, cfg, created: false };
}
