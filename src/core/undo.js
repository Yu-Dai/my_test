// kb undo：撤銷最近一次由 kb 做的頁面變更（ingest 或 edit）。
// 做法是新增一筆反向的 commit，不用 reset：歷史保留，已經推到共享資料夾的 commit 也能安全撤銷。
// log.md 只增不改，所以原本的紀錄保留，另外附加一筆 undo。
// 來源檔與圖片的工作複本會留著，撤銷後該來源回到「待處理」狀態，可以重新 ingest。

import fs from 'node:fs';
import path from 'node:path';
import { changes, git, hasIdentity, headShort, isRepoRoot } from './git.js';
import { writeIndexes } from './indexgen.js';
import { LOG_PATH, STATE_PATH, appendLog } from './init.js';
import { loadKb } from './kb.js';
import { pathToPageId } from './ids.js';
import { PROVENANCE_PATH, readProvenance, refreshPages, writeProvenance } from './provenance.js';

const ID_RE = /\[(\d{8}-\d{6}-[0-9a-f]{4})\]$/;
const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
const abs = (root, rel) => path.join(root, ...rel.split('/'));

/** 找出最近一筆還沒被撤銷的 ingest／edit commit。 */
export function findUndoTarget(root) {
  const r = git(root, ['log', '-n', '500', '--format=%H%x09%s']);
  if (!r.ok) return null;
  const undone = new Set();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [hash, subject] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
    const id = ID_RE.exec(subject)?.[1];
    if (subject.startsWith('undo: ')) {
      if (id) undone.add(id);
    } else if (/^(ingest|edit): /.test(subject) && id && !undone.has(id)) {
      return { hash, subject, id };
    }
  }
  return null;
}

export function undoLast(root) {
  if (!isRepoRoot(root)) return fail(`${root} 不是 git repo，沒有可以撤銷的紀錄`);
  if (fs.existsSync(abs(root, STATE_PATH))) return fail('目前有來源正在處理中', '先完成它：kb ingest commit；或放棄它：kb ingest abort。之後再執行 kb undo');
  const dirty = changes(root).filter((c) => c.path.startsWith('wiki/') || [LOG_PATH, 'index.md'].includes(c.path) || c.path.startsWith('.kb/'));
  if (dirty.length) return fail(`有尚未 commit 的變更：${dirty.map((c) => c.path).join('、')}`, '先處理它們：kb commit "說明"（保留）或 kb ingest abort（放棄）。之後再執行 kb undo');
  if (!hasIdentity(root)) return fail('git 還沒設定使用者名稱與信箱，無法建立 commit', '請使用者先執行：git config --global user.name "姓名" 與 git config --global user.email "信箱"');

  const target = findUndoTarget(root);
  if (!target) return { code: 0, text: '沒有可以撤銷的變更：找不到尚未撤銷的 ingest 或 edit 紀錄。' };

  // 這筆 commit 動到的檔案
  const files = git(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', target.hash]).stdout.split('\0').filter(Boolean);
  const touched = [];
  for (let i = 0; i + 1 < files.length; i += 2) touched.push({ status: files[i], path: files[i + 1] });
  // 來源檔與圖片的工作複本要留著
  const keep = touched.filter((t) => (t.path.startsWith('raw/') || t.path.startsWith('assets/')) && fs.existsSync(abs(root, t.path))).map((t) => ({ path: t.path, bytes: fs.readFileSync(abs(root, t.path)) }));

  // 只對內容檔（頁面、來源、圖片）套用反向 patch；索引、對應表、log 是產生出來的，之後重新產生。
  // git apply 是全有或全無：套不上就什麼都不會改。
  const patch = git(root, ['diff', '--binary', target.hash, `${target.hash}^`, '--', 'wiki', 'raw', 'assets']);
  const ap = patch.ok && patch.stdout ? git(root, ['apply', '--index', '--binary', '--whitespace=nowarn'], patch.stdout) : patch;
  if (!ap.ok) {
    return fail(`無法自動撤銷「${target.subject}」：之後的變更改到了同樣的內容，無法還原`, '請維護者手動處理，或直接修改頁面後用 kb commit 記錄');
  }
  for (const k of keep) {
    fs.mkdirSync(path.dirname(abs(root, k.path)), { recursive: true });
    fs.writeFileSync(abs(root, k.path), k.bytes);
  }
  const kb = loadKb(root);
  writeIndexes(kb);
  // 對應表：拿掉這次 ingest 的紀錄，來源 hash 退回前一次；沒有前一次就整筆移除
  const prov = readProvenance(root);
  const source = /^ingest: (.+) \[[^\]]+\]$/.exec(target.subject)?.[1];
  const entry = source ? prov.sources[source] : null;
  if (entry) {
    entry.ingests = entry.ingests.filter((i) => i.id !== target.id);
    if (entry.ingests.length === 0) delete prov.sources[source];
    else entry.hash = entry.ingests[entry.ingests.length - 1].hash;
  }
  writeProvenance(root, refreshPages(prov, kb.pages));
  appendLog(root, `undo | ${target.subject}`);
  const message = `undo: ${target.subject}`;
  let r = git(root, ['add', '--', 'index.md', LOG_PATH, '.kb/search-index.json', PROVENANCE_PATH]);
  if (r.ok) r = git(root, ['commit', '-q', '-m', message]);
  if (!r.ok) return fail(`git commit 失敗：${r.stderr}`, '請維護者檢查 git 狀態');

  const page = (t) => pathToPageId(t.path);
  const list = (status) => touched.filter((t) => t.status === status && page(t)).map(page);
  const out = [`已撤銷：${target.subject}`];
  if (list('A').length) out.push(`- 移除了當時新增的頁面：${list('A').join('、')}`);
  if (list('M').length) out.push(`- 還原了當時修改的頁面：${list('M').join('、')}`);
  if (list('D').length) out.push(`- 恢復了當時刪除的頁面：${list('D').join('、')}`);
  out.push(`- commit：${headShort(root)}（${message}）`);
  const sources = keep.filter((k) => k.path.startsWith('raw/')).map((k) => k.path);
  if (sources.length) out.push('', `來源檔 ${sources.join('、')} 還在 raw/，現在是待處理狀態。`, `重新處理：kb ingest start ${sources[0]}`);
  const errors = kb.issues.filter((i) => i.level === 'error');
  if (errors.length) out.push('', `注意：撤銷後知識庫有 ${errors.length} 個錯誤，執行 kb check 查看。`);
  return { code: 0, text: out.join('\n') };
}
