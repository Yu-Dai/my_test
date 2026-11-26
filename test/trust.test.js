import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  cloneKb, git, ingestStart, initKb, mountAdd, mountList, pullKb, pushKb, remoteStatus, shareKb, trustLocation, untrustedBy,
} from '../src/core/index.js';
import { cachePathFor, syncRemote } from '../src/mcp/cache.js';
import { Mounts } from '../src/mcp/mounts.js';
import { getWikiInfo } from '../src/mcp/tools.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-trust-'));
// 這個檔案的測試會寫入 git 的全域設定，改用暫存檔，不碰執行測試的人自己的設定
const GLOBAL_CONFIG = path.join(base, 'gitconfig');
fs.writeFileSync(GLOBAL_CONFIG, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GLOBAL_CONFIG, GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' });

const trusted = () => git(base, ['config', '--global', '--get-all', 'safe.directory']).stdout.trim().split('\n').filter(Boolean);
const config = (name) => {
  const file = path.join(base, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ knowledge_bases: [] }));
  return { file, where: { config: file, env: {} } };
};

/** 一個已經共享出去的知識庫：回傳工作複本與共享位置。 */
function shared(name) {
  const work = path.join(base, `${name}-work`);
  const remote = path.join(base, 'share', `${name}.git`);
  assert.equal(initKb(work, { name, title: name, description: '測試用', owner: 'tester', category: 'test', confidentiality: 'internal' }).code, 0);
  const r = shareKb(work, remote);
  assert.equal(r.code, 0, r.text);
  return { work, remote };
}

// 先在一般狀態下建好，再讓 git 把所有儲存庫都當成「擁有者不是你」，模擬網路磁碟機上的情況
const one = shared('one');
const two = shared('two');
const three = shared('three');
process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

test('untrustedBy：認出 git 的拒絕訊息並取出它建議的寫法', () => {
  const posix = "fatal: detected dubious ownership in repository at '/srv/kb/x.git'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/kb/x.git\n";
  assert.deepEqual(untrustedBy(posix), { value: '/srv/kb/x.git' });
  const windows = "fatal: detected dubious ownership in repository at '//FS/share/kb/x.git'\n'//FS/share/kb/x.git' may refer to a non-local directory\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '%(prefix)///FS/share/kb/x.git'\r\n";
  assert.deepEqual(untrustedBy(windows), { value: '%(prefix)///FS/share/kb/x.git' });
  assert.deepEqual(untrustedBy('fatal: detected dubious ownership in repository'), { value: null });
  assert.equal(untrustedBy("fatal: '/nope' does not appear to be a git repository"), null);
  assert.equal(untrustedBy(''), null);
});

test('mount add：被 git 拒絕時說明原因，不會自動信任；加 --trust 才信任並加入', () => {
  const { file, where } = config('mount');
  const refused = mountAdd(where, one.remote);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /無法加入：git 拒絕讀取這個位置的儲存庫[\s\S]*kb mount add ".*one\.git" --trust[\s\S]*能寫入那個資料夾的人/);
  assert.deepEqual(trusted(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).knowledge_bases, []);

  const ok = mountAdd(where, one.remote, { trust: true });
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /已加入共享知識庫[\s\S]*代號 one/);
  assert.deepEqual(trusted(), [one.remote]);
  // 已經信任的位置不會重複寫入
  assert.equal(mountAdd(where, one.remote, { trust: true }).code, 0);
  assert.deepEqual(trusted(), [one.remote]);
});

test('mount list：還沒信任的共享知識庫標示原因與要執行的指令', () => {
  const { file, where } = config('list');
  fs.writeFileSync(file, JSON.stringify({ knowledge_bases: [{ remote: one.remote }, { remote: two.remote }] }));
  const out = mountList(where).text;
  assert.match(out, /- one {2}共享 .*機密等級 internal/);
  assert.match(out, /two\.git\n {4}\[有問題\] git 拒絕讀取這個位置的儲存庫[\s\S]*kb trust ".*two\.git"/);
});

test('kb trust：信任一個位置；不存在、不是儲存庫、已經信任的情況', () => {
  assert.match(trustLocation(undefined).text, /沒有指定要信任的位置/);
  assert.match(trustLocation(path.join(base, 'nope')).text, /找不到/);
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  assert.match(trustLocation(plain).text, /不是 git 儲存庫，或無法讀取/);
  assert.equal(trusted().includes(two.remote), false);

  const r = trustLocation(two.remote);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已信任這個位置[\s\S]*safe\.directory = .*two\.git/);
  assert.equal(trusted().includes(two.remote), true);
  const again = trustLocation(two.remote);
  assert.match(again.text, /git 已經接受這個位置，不需要設定/);
  assert.equal(trusted().filter((p) => p === two.remote).length, 1);
});

test('clone：被拒絕時給帶 --trust 的指令；加了才信任並取得工作複本', () => {
  const dir = path.join(base, 'three-copy');
  const refused = cloneKb(three.remote, dir);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /git 拒絕讀取這個位置的儲存庫[\s\S]*kb clone ".*three\.git" ".*three-copy" --trust/);
  assert.equal(fs.existsSync(dir), false);
  const ok = cloneKb(three.remote, dir, { trust: true });
  assert.equal(ok.code, 0, ok.text);
  assert.ok(fs.existsSync(path.join(dir, 'kb.json')));
});

test('push／pull／ingest start：共享位置還沒信任時說明原因，不誤報成連不上', () => {
  const four = (() => {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    const made = shared('four');
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    return made;
  })();
  // 工作複本在本機，本來就會被接受；這裡只讓共享位置維持未信任
  git(base, ['config', '--global', '--add', 'safe.directory', four.work]);
  const st = remoteStatus(four.work);
  assert.deepEqual([st.reachable, st.untrusted], [false, true]);
  for (const run of [pushKb, pullKb]) {
    const r = run(four.work);
    assert.equal(r.code, 1);
    assert.match(r.text, /git 拒絕讀取這個位置的儲存庫：.*four\.git[\s\S]*kb trust ".*four\.git"/);
    assert.doesNotMatch(r.text, /連不到共享位置/);
  }
  fs.writeFileSync(path.join(four.work, 'raw', 'note.txt'), 'hello\n');
  const start = ingestStart(four.work, 'raw/note.txt');
  assert.equal(start.code, 0, start.text);
  assert.match(start.text, /注意：git 拒絕讀取這個位置的儲存庫[\s\S]*kb trust ".*four\.git"/);

  assert.equal(trustLocation(four.remote).code, 0);
  assert.deepEqual([remoteStatus(four.work).reachable, remoteStatus(four.work).untrusted], [true, false]);
  assert.match(pushKb(four.work).text, /沒有需要推送的變更/);
});

test('MCP：共享知識庫還沒信任時，GetWikiInfo 說明原因與要執行的指令', async () => {
  delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  const five = shared('five');
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  const cache = path.join(base, 'cache');
  const r = await syncRemote(five.remote, cachePathFor(cache, five.remote));
  assert.deepEqual([r.ok, r.untrusted], [false, true]);
  const m = new Mounts([{ remote: five.remote }], [], { cacheDir: cache });
  await m.syncAll();
  const out = getWikiInfo(m, {});
  assert.match(out, /沒有掛載：git 拒絕讀取這個位置的儲存庫[\s\S]*node ".*kb\.js" trust ".*five\.git"，然後重新啟動 MCP/);
  assert.doesNotMatch(out, /確認共享資料夾連得上/);

  assert.equal(trustLocation(five.remote).code, 0);
  await m.syncAll();
  assert.deepEqual(m.names(), ['five']);
});
