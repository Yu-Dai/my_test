// 共享知識庫所在的位置如果是網路磁碟機，或資料夾的擁有者不是目前的使用者，git 會拒絕操作那個儲存庫
// （訊息是 "detected dubious ownership"），要使用者把位置加進全域設定的 safe.directory 才放行。
// 這裡負責認出這個狀況、給一致的說明，並在使用者明確要求時代為加入。不會自動信任任何位置。

import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

const REFUSED = /dubious ownership/i;
const SUGGESTED_COMMAND = /git config --global --add safe\.directory\s+(.+?)\s*$/m;
const lastLine = (s) => s.split('\n').filter(Boolean).pop() ?? '';

export const UNTRUSTED_REASON = 'git 拒絕讀取這個位置的儲存庫：它在網路磁碟機上，或資料夾的擁有者不是你，git 無法確認它是你的';
const CONSEQUENCE = '信任之後，能寫入那個資料夾的人都能影響你電腦上 git 的行為，所以只信任自己人維護的位置';

/**
 * git 的錯誤訊息是不是「無法確認擁有者而拒絕」。
 * @param {string} stderr
 * @returns {{ value: string|null }|null} 是的話回傳 git 建議加進 safe.directory 的寫法（讀不出來時 value 是 null）；不是回傳 null
 */
export function untrustedBy(stderr) {
  if (!REFUSED.test(stderr)) return null;
  const m = SUGGESTED_COMMAND.exec(stderr);
  return { value: m ? m[1].replace(/^'(.*)'$/, '$1') : null };
}

/** 被 git 拒絕時給使用者的下一步。command 是使用者該執行的整行指令。 */
export function untrustedNext(command) {
  return `確定這個位置可以信任時執行：${command}\n  ${CONSEQUENCE}`;
}

/**
 * kb trust：把一個位置加進 git 的信任清單（全域設定的 safe.directory）。git 本來就接受的位置不做任何事。
 * @param {string} targetArg 共享儲存庫或知識庫資料夾
 * @returns {{ code: number, text: string }}
 */
export function trustLocation(targetArg) {
  const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
  if (!targetArg) return fail('沒有指定要信任的位置', 'kb trust <共享資料夾>/<代號>.git');
  const target = path.resolve(targetArg);
  if (!fs.existsSync(target)) return fail(`找不到 ${target}`, '確認路徑是否正確；共享資料夾要先連得上');

  const probe = git(target, ['rev-parse', '--git-dir']);
  if (probe.ok) return { code: 0, text: `git 已經接受這個位置，不需要設定：${target}` };
  const refused = untrustedBy(probe.stderr);
  if (!refused) return fail(`${target} 不是 git 儲存庫，或無法讀取（${lastLine(probe.stderr)}）`, '確認路徑指到共享資料夾上的 <代號>.git，或知識庫的資料夾');
  if (!refused.value) return fail(`git 拒絕讀取 ${target}，但讀不出它要求的設定`, `請把以下訊息交給維護者：\n${probe.stderr}`);

  const added = git(process.cwd(), ['config', '--global', '--add', 'safe.directory', refused.value]);
  if (!added.ok) return fail(`無法寫入 git 的全域設定：${lastLine(added.stderr)}`, `請自行執行：git config --global --add safe.directory "${refused.value}"`);
  const again = git(target, ['rev-parse', '--git-dir']);
  if (!again.ok) return fail(`已加入信任清單，但 git 仍然無法讀取 ${target}（${lastLine(again.stderr)}）`, '請把這段訊息交給維護者');
  return { code: 0, text: `已信任這個位置：${target}\n寫入的是 git 全域設定 safe.directory = ${refused.value}。${CONSEQUENCE}。` };
}
