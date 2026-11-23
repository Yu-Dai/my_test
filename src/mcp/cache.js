// 共享知識庫的本機快取。MCP 不直接讀網路資料夾：大量小檔案讀取慢，也可能讀到更新到一半的狀態。
// 快取是可以隨時砍掉重來的複本，所以更新時直接對齊遠端，不保留本機變更。

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 5 * 60 * 1000;

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stderr: String(stderr || error?.message || '').trim() });
    });
  });
}

/** 一個遠端對應一個固定的快取資料夾。 */
export function cachePathFor(cacheDir, remote) {
  const base = path.basename(remote.replace(/[\\/]+$/, '')).replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'kb';
  return path.join(cacheDir, `${base}-${crypto.createHash('sha1').update(remote).digest('hex').slice(0, 8)}`);
}

const infoPath = (dir) => `${dir}.sync.json`;

/** 上次成功同步的時間。沒有快取回傳 null。 */
export function readSyncInfo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    return JSON.parse(fs.readFileSync(infoPath(dir), 'utf8'));
  } catch {
    return { synced: null };
  }
}

/**
 * 把遠端 bare repo 同步到本機快取。第一次是 clone，之後是 fetch 並對齊遠端。
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function syncRemote(remote, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let r;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    // 先 clone 到暫存資料夾再改名，避免留下複製到一半的快取
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    r = await run(['clone', '--quiet', '--no-tags', remote, tmp]);
    if (r.ok) {
      try {
        fs.renameSync(tmp, dir);
      } catch (e) {
        r = { ok: false, stderr: `無法建立快取資料夾：${e.message}` };
      }
    }
    if (!r.ok) fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    r = await run(['fetch', '--quiet', '--no-tags', remote, 'HEAD'], dir);
    if (r.ok) r = await run(['reset', '--quiet', '--hard', 'FETCH_HEAD'], dir);
    if (r.ok) r = await run(['clean', '-fdq'], dir);
  }
  if (!r.ok) return { ok: false, error: r.stderr.split('\n').filter(Boolean).pop() ?? '未知錯誤' };
  fs.writeFileSync(infoPath(dir), `${JSON.stringify({ remote, synced: new Date().toISOString() }, null, 2)}\n`);
  return { ok: true, error: null };
}
