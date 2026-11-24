// 掛載設定：放在使用者端，列出要用的知識庫。公司專屬路徑（共享資料夾位置）只出現在這裡，不進 repo。
//
// 設定檔位置（依序）：--config <路徑>、環境變數 LLM_WIKI_CONFIG、~/.llm-wiki/config.json
// 設定檔由 kb mount／kb config 指令建立與修改（src/core/mount.js），這裡只讀。
// 另外可用 --kb <路徑>（可重複）直接指定本機知識庫，不需設定檔。
//
// {
//   "max_confidentiality": "internal",          可掛載的最高機密等級，省略時為 internal
//   "cache_dir": "D:/cache/llm-wiki",           共享知識庫的本機快取位置，省略時為 ~/.llm-wiki/cache
//   "knowledge_bases": [
//     { "path": "D:/kb/my-notes" },             本機知識庫（個人知識庫，或維護者的工作複本）
//     { "remote": "//server/share/kb/uart.git" } 共享知識庫：共享資料夾上的 bare repo，會複製到本機快取
//   ]
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIDENTIALITY_LEVELS, DEFAULT_MAX_CONFIDENTIALITY, defaultCacheDir, defaultConfigPath } from '../core/index.js';

export { defaultCacheDir, defaultConfigPath };

// 只用 MCP 的使用者不一定把 kb 加進 PATH，所以引導訊息給完整的執行方式
const KB_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'kb.js');

export const CONFIG_EXAMPLE = JSON.stringify({ max_confidentiality: 'internal', knowledge_bases: [{ path: 'D:/kb/my-notes' }, { remote: '//server/share/kb/uart-driver.git' }] }, null, 2);

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ configPath: string|null, entries: ({ path: string }|{ remote: string })[], paths: string[], maxConfidentiality: string, cacheDir: string, problems: string[] }}
 */
export function loadConfig(argv, env = process.env) {
  const problems = [];
  const entries = [];
  let explicit = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') explicit = argv[++i];
    else if (argv[i] === '--kb') entries.push({ path: path.resolve(argv[++i] ?? '') });
  }
  const configPath = explicit ?? env.LLM_WIKI_CONFIG ?? defaultConfigPath();
  const required = Boolean(explicit ?? env.LLM_WIKI_CONFIG) || entries.length === 0;
  const result = (cfgPath, extra = {}) => ({
    configPath: cfgPath,
    entries,
    paths: entries.filter((e) => e.path).map((e) => e.path),
    maxConfidentiality: DEFAULT_MAX_CONFIDENTIALITY,
    cacheDir: defaultCacheDir(env),
    problems,
    ...extra,
  });

  if (!fs.existsSync(configPath)) {
    if (explicit ?? env.LLM_WIKI_CONFIG) problems.push(`找不到設定檔 ${configPath}。請使用者確認 --config 或環境變數 LLM_WIKI_CONFIG 指定的路徑是否正確`);
    else if (required) problems.push(`找不到設定檔 ${configPath}。請使用者在終端機執行以下指令加入知識庫，然後重新啟動 MCP：\n  node "${KB_CLI}" mount add <知識庫資料夾，或共享資料夾上的 .git 路徑>`);
    return result(required ? configPath : null);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\ufeff/, ''));
  } catch (e) {
    problems.push(`設定檔 ${configPath} 不是合法的 JSON：${e.message}`);
    return result(configPath);
  }
  const list = cfg?.knowledge_bases;
  if (!Array.isArray(list)) {
    problems.push(`設定檔 ${configPath} 缺少 knowledge_bases 清單。內容範例：\n${CONFIG_EXAMPLE}`);
    return result(configPath);
  }
  const base = path.dirname(configPath);
  for (const item of list) {
    const local = typeof item === 'string' ? item : item?.path;
    const remote = typeof item === 'object' ? item?.remote : null;
    if (typeof remote === 'string' && remote.trim()) {
      entries.push({ remote: remote.includes('://') ? remote.trim() : path.resolve(base, remote.trim()) });
    } else if (typeof local === 'string' && local.trim()) {
      entries.push({ path: path.resolve(base, local.trim()) });
    } else {
      problems.push(`設定檔 ${configPath} 的 knowledge_bases 有一筆沒有 path 也沒有 remote：${JSON.stringify(item)}`);
    }
  }
  let maxConfidentiality = DEFAULT_MAX_CONFIDENTIALITY;
  if (cfg.max_confidentiality !== undefined) {
    if (CONFIDENTIALITY_LEVELS.includes(cfg.max_confidentiality)) maxConfidentiality = cfg.max_confidentiality;
    else problems.push(`設定檔 ${configPath} 的 max_confidentiality 必須是 ${CONFIDENTIALITY_LEVELS.join('、')} 其中之一，目前先當作 ${DEFAULT_MAX_CONFIDENTIALITY}`);
  }
  const cacheDir = typeof cfg.cache_dir === 'string' && cfg.cache_dir.trim() ? path.resolve(base, cfg.cache_dir.trim()) : defaultCacheDir(env);
  return result(configPath, { maxConfidentiality, cacheDir });
}
