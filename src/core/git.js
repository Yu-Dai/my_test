// git 包裝。每個知識庫是獨立的 git repo，所有 commit 都由 CLI 產生。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 執行 git，回傳 { ok, stdout, stderr }。 */
export function git(root, args, input) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '') };
}

/** 知識庫資料夾本身是否為 git repo 的根目錄。 */
export function isRepoRoot(root) {
  return fs.existsSync(path.join(root, '.git'));
}

/** 是否已設定 commit 用的身分。 */
export function hasIdentity(root) {
  if (process.env.GIT_AUTHOR_NAME && process.env.GIT_AUTHOR_EMAIL) return true;
  return Boolean(git(root, ['config', 'user.name']).stdout.trim() && git(root, ['config', 'user.email']).stdout.trim());
}

/**
 * 工作區的變更清單。
 * @returns {{ path: string, kind: 'added'|'modified'|'deleted' }[]}
 */
export function changes(root) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (!r.ok) throw new Error(`git status 失敗：${r.stderr}`);
  const out = [];
  for (const entry of r.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    const kind = xy === '??' || xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : 'modified';
    out.push({ path: p, kind });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function headShort(root) {
  return git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
}
