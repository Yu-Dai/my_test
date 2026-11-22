// 掛載設定：放在使用者端，列出要用的知識庫路徑。公司專屬路徑只出現在這裡，不進 repo。
//
// 設定檔位置（依序）：--config <路徑>、環境變數 LLM_WIKI_CONFIG、~/.llm-wiki/config.json
// 另外可用 --kb <路徑>（可重複）直接指定知識庫，不需設定檔。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_EXAMPLE = JSON.stringify({ knowledge_bases: [{ path: 'D:/kb/my-notes' }, { path: 'D:/kb/uart-driver' }] }, null, 2);

export function defaultConfigPath() {
  return path.join(os.homedir(), '.llm-wiki', 'config.json');
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ configPath: string|null, paths: string[], problems: string[] }}
 */
export function loadConfig(argv, env = process.env) {
  const problems = [];
  const paths = [];
  let explicit = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') explicit = argv[++i];
    else if (argv[i] === '--kb') paths.push(path.resolve(argv[++i] ?? ''));
  }
  const configPath = explicit ?? env.LLM_WIKI_CONFIG ?? defaultConfigPath();
  const required = Boolean(explicit ?? env.LLM_WIKI_CONFIG) || paths.length === 0;

  if (!fs.existsSync(configPath)) {
    if (required) problems.push(`找不到設定檔 ${configPath}。請建立這個檔案，內容範例：\n${CONFIG_EXAMPLE}`);
    return { configPath: required ? configPath : null, paths, problems };
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\ufeff/, ''));
  } catch (e) {
    problems.push(`設定檔 ${configPath} 不是合法的 JSON：${e.message}`);
    return { configPath, paths, problems };
  }
  const list = cfg?.knowledge_bases;
  if (!Array.isArray(list)) {
    problems.push(`設定檔 ${configPath} 缺少 knowledge_bases 清單。內容範例：\n${CONFIG_EXAMPLE}`);
    return { configPath, paths, problems };
  }
  const base = path.dirname(configPath);
  for (const item of list) {
    const p = typeof item === 'string' ? item : item?.path;
    if (typeof p !== 'string' || !p.trim()) {
      problems.push(`設定檔 ${configPath} 的 knowledge_bases 有一筆沒有 path：${JSON.stringify(item)}`);
      continue;
    }
    paths.push(path.resolve(base, p));
  }
  return { configPath, paths, problems };
}
