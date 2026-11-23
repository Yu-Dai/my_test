// 共享知識庫（維護端）：沒有 git server，所以在共享資料夾上放 bare repo 當遠端，以檔案路徑存取。
// 維護者在自己本機的工作複本作業，完成後推上去。共享資料夾的路徑只存在 git 設定裡，不寫進知識庫內容。

import fs from 'node:fs';
import path from 'node:path';
import { changes, git, isRepoRoot } from './git.js';
import { STATE_PATH } from './init.js';

const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
const lastLine = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const branchOf = (root) => git(root, ['branch', '--show-current']).stdout.trim() || 'main';

export function originUrl(root) {
  const r = git(root, ['remote', 'get-url', 'origin']);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * 與遠端的差距。fetch 失敗（離線）時 reachable 為 false，ahead/behind 依上次已知的狀態計算。
 * @returns {{ origin: string|null, reachable: boolean, ahead: number, behind: number, error: string|null }}
 */
export function remoteStatus(root, { fetch = true } = {}) {
  const origin = originUrl(root);
  if (!origin) return { origin: null, reachable: false, ahead: 0, behind: 0, error: null };
  const branch = branchOf(root);
  let reachable = true;
  let error = null;
  if (fetch) {
    const f = git(root, ['fetch', '--quiet', 'origin']);
    reachable = f.ok;
    error = f.ok ? null : lastLine(f.stderr);
  }
  const r = git(root, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  if (!r.ok) {
    // 遠端還沒有這個分支（剛建立、尚未推送）
    const n = Number(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim()) || 0;
    return { origin, reachable, ahead: n, behind: 0, error };
  }
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return { origin, reachable, ahead, behind, error };
}

function isBareRepo(dir) {
  return fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects'));
}

/** kb share：第一次把知識庫放上共享資料夾。 */
export function shareKb(root, targetArg) {
  if (!isRepoRoot(root)) return fail(`${root} 不是 git repo`, '知識庫要用 kb init 建立');
  const existing = originUrl(root);
  if (!targetArg) {
    return existing
      ? { code: 0, text: `這個知識庫已經設定共享位置：${existing}\n推送變更：kb push` }
      : fail('沒有指定共享位置', '向使用者問清楚共享資料夾上要放的路徑，然後執行：kb share <共享資料夾路徑>/<知識庫代號>.git');
  }
  const target = path.resolve(targetArg);
  if (existing) return fail(`這個知識庫已經設定共享位置：${existing}`, '推送變更請用 kb push。要換位置請維護者手動處理（git remote set-url origin <新路徑>）');
  if (changes(root).some((c) => c.path.startsWith('wiki/')) || fs.existsSync(path.join(root, ...STATE_PATH.split('/')))) {
    return fail('有尚未 commit 的頁面變更', '先完成：kb ingest commit 或 kb commit "說明"，再執行 kb share');
  }

  let created = false;
  if (!fs.existsSync(target) || fs.readdirSync(target).length === 0) {
    const r = git(root, ['init', '--quiet', '--bare', '-b', branchOf(root), target]);
    if (!r.ok) return fail(`無法在 ${target} 建立共享儲存庫：${lastLine(r.stderr)}`, '確認共享資料夾連得上，而且你有寫入權限');
    created = true;
  } else if (!isBareRepo(target)) {
    return fail(`${target} 已經存在，而且不是共享儲存庫`, '換一個新的路徑，慣例是 <共享資料夾>/<知識庫代號>.git');
  }
  git(root, ['remote', 'add', 'origin', target]);
  const push = git(root, ['push', '--quiet', '-u', 'origin', branchOf(root)]);
  if (!push.ok) {
    git(root, ['remote', 'remove', 'origin']);
    const hint = created ? '確認共享資料夾的寫入權限' : '這個位置已經有別的知識庫的內容。換一個路徑；如果是要加入既有的共享知識庫，請用 kb clone';
    return fail(`推送到 ${target} 失敗：${lastLine(push.stderr)}`, hint);
  }
  return {
    code: 0,
    text: [
      `已共享到：${target}`,
      '',
      '告訴使用者：',
      `- 要用這個知識庫的人，在 wiki MCP 的設定檔 knowledge_bases 加上：{ "remote": ${JSON.stringify(target.split('\\').join('/'))} }`,
      `- 其他維護者取得工作複本：kb clone ${target} <本機資料夾>`,
      '之後每次改完內容，執行 kb push 才會讓其他人看到。',
    ].join('\n'),
  };
}

/** kb push：把本機的 commit 推到共享資料夾。 */
export function pushKb(root) {
  if (!isRepoRoot(root)) return fail(`${root} 不是 git repo`);
  const origin = originUrl(root);
  if (!origin) return fail('這個知識庫還沒有設定共享位置', '第一次共享：kb share <共享資料夾路徑>/<知識庫代號>.git');
  const st = remoteStatus(root);
  if (!st.reachable) return fail(`連不到共享位置 ${origin}（${st.error}）`, '確認共享資料夾連得上再試一次。本機的變更都還在，不會遺失');
  if (st.behind > 0) {
    return fail(`共享位置有 ${st.behind} 筆別人推送的新變更，要先取得才能推送`, st.ahead > 0 ? '執行 kb pull（它會說明怎麼處理兩邊都有變更的情況）' : '執行 kb pull');
  }
  if (st.ahead === 0) return { code: 0, text: `沒有需要推送的變更，共享位置已經是最新的：${origin}` };
  const r = git(root, ['push', '--quiet', 'origin', branchOf(root)]);
  if (!r.ok) return fail(`推送失敗：${lastLine(r.stderr)}`, '可能有人剛好同時推送。執行 kb pull 後再試一次 kb push');
  const pending = changes(root).some((c) => c.path.startsWith('wiki/')) ? '\n注意：wiki/ 還有尚未 commit 的變更，沒有被推送。' : '';
  return { code: 0, text: `已推送 ${st.ahead} 筆變更到：${origin}\n使用者的 wiki MCP 下次啟動時會取得新內容。${pending}` };
}

/** kb pull：取得共享位置上別人推送的變更。只做快轉，不自動合併。 */
export function pullKb(root) {
  if (!isRepoRoot(root)) return fail(`${root} 不是 git repo`);
  const origin = originUrl(root);
  if (!origin) return fail('這個知識庫還沒有設定共享位置', '第一次共享：kb share <共享資料夾路徑>/<知識庫代號>.git');
  if (fs.existsSync(path.join(root, ...STATE_PATH.split('/'))) || changes(root).some((c) => c.path.startsWith('wiki/'))) {
    return fail('有尚未 commit 的頁面變更', '先完成（kb ingest commit 或 kb commit "說明"）或放棄（kb ingest abort），再執行 kb pull');
  }
  const st = remoteStatus(root);
  if (!st.reachable) return fail(`連不到共享位置 ${origin}（${st.error}）`, '確認共享資料夾連得上再試一次');
  if (st.behind === 0) return { code: 0, text: `已經是最新的，沒有新的變更。${st.ahead ? `本機有 ${st.ahead} 筆變更尚未推送：kb push` : ''}` };
  if (st.ahead > 0) {
    return fail(
      `本機與共享位置各自有新的變更（本機 ${st.ahead} 筆、共享位置 ${st.behind} 筆），無法自動合併`,
      [
        '這需要維護者決定，請把以下內容轉告使用者，不要自行處理：',
        '    索引、對應表、log 是產生出來的檔案，兩邊同時修改一定會衝突，所以這裡不自動合併。',
        `    做法：用 kb undo 逐筆撤銷本機這 ${st.ahead} 筆變更（來源檔會留著），執行 kb pull 取得共享位置的版本，再重新 kb ingest。`,
        '    為了避免再發生：開始作業前先 kb pull，作業完成後馬上 kb push。',
      ].join('\n'),
    );
  }
  const r = git(root, ['merge', '--quiet', '--ff-only', `origin/${branchOf(root)}`]);
  if (!r.ok) return fail(`取得變更失敗：${lastLine(r.stderr)}`, '請維護者檢查 git 狀態');
  return { code: 0, text: `已取得 ${st.behind} 筆新變更，現在與共享位置一致。` };
}

/** kb clone：其他維護者從共享位置取得工作複本。 */
export function cloneKb(remoteArg, dirArg) {
  if (!remoteArg || !dirArg) return fail('需要共享位置與本機資料夾', 'kb clone <共享資料夾路徑>/<知識庫代號>.git <本機資料夾>');
  const remote = path.resolve(remoteArg);
  const dir = path.resolve(dirArg);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return fail(`${dir} 已經存在而且不是空的`, '換一個新的資料夾路徑');
  const r = git(process.cwd(), ['clone', '--quiet', remote, dir]);
  if (!r.ok) return fail(`無法從 ${remote} 取得知識庫：${lastLine(r.stderr)}`, '確認共享資料夾連得上、路徑正確');
  if (!fs.existsSync(path.join(dir, 'kb.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    return fail(`${remote} 不是知識庫（裡面沒有 kb.json）`, '確認路徑是否正確');
  }
  return { code: 0, text: `已取得工作複本：${dir}\n下一步：切換到該資料夾作業。開始前先 kb pull，完成後 kb push。` };
}
