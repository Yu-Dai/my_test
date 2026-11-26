import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  LIMITS, cloneKb, editCommit, git, ingestCommit, ingestStart, initKb, pullKb, pushKb, remoteStatus, shareKb, validateKbJson,
} from '../src/core/index.js';
import { cachePathFor, readSyncInfo, syncRemote } from '../src/mcp/cache.js';
import { loadConfig } from '../src/mcp/config.js';
import { Mounts } from '../src/mcp/mounts.js';
import { getWikiInfo, readWiki, searchWikiTool } from '../src/mcp/tools.js';
import { CLI, KB_JSON, RAW_CODE, RAW_SPEC, REPO_ROOT, SAMPLE_KB, makeKb, makePage } from './helpers.js';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' });

const FIELDS = { name: 'shared-kb', title: '共享知識庫', description: '測試用', owner: 'tester', category: 'test', confidentiality: 'internal' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-shared-'));
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const draft = (fm = {}) => makePage({ updated: undefined, sources: '\n  - raw/spec.md#2.1', ...fm });
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).stdout.trim();

/** 模擬的環境：共享資料夾 share/、維護者甲的工作複本 a/（已 ingest 一頁）。 */
function world({ shared = true, name = FIELDS.name } = {}) {
  const base = tmp();
  const a = path.join(base, 'a');
  const remote = path.join(base, 'share', 'shared-kb.git');
  assert.equal(initKb(a, { ...FIELDS, name }).code, 0);
  put(a, 'raw/spec.md', RAW_SPEC);
  ingestStart(a, 'raw/spec.md');
  put(a, 'wiki/topic/alpha.md', draft({ title: '阿法' }));
  assert.equal(ingestCommit(a).code, 0);
  if (shared) assert.equal(shareKb(a, remote).code, 0);
  return { base, a, remote, cache: path.join(base, 'cache') };
}

function addPage(root, name, note) {
  put(root, `wiki/topic/${name}.md`, draft({ title: name }));
  const r = editCommit(root, note ?? `加 ${name}`);
  assert.equal(r.code, 0, r.text);
  return r;
}

// -------------------------------------------------------------------- 機密等級

test('kb.json：confidentiality 只能是三個等級之一', () => {
  for (const level of ['public', 'internal', 'confidential']) {
    assert.deepEqual(validateKbJson(JSON.stringify({ ...KB_JSON, confidentiality: level })).issues, []);
  }
  for (const bad of ['secret', 'Public', '', 3]) {
    assert.deepEqual(validateKbJson(JSON.stringify({ ...KB_JSON, confidentiality: bad })).issues.map((i) => i.code), ['kbjson-confidentiality']);
  }
  assert.match(initKb(path.join(tmp(), 'kb'), { ...FIELDS, confidentiality: '機密' }).text, /confidentiality 必須是 public、internal、confidential 其中之一/);
});

test('掛載：機密等級超過設定允許的就不掛載，並說明怎麼調整', () => {
  const kb = (level) => makeKb({ 'kb.json': JSON.stringify({ ...KB_JSON, name: `kb-${level}`, confidentiality: level }) });
  const all = [kb('public'), kb('internal'), kb('confidential')];
  const dflt = new Mounts(all);
  assert.deepEqual(dflt.names(), ['kb-public', 'kb-internal']);
  assert.match(dflt.problems[0], /知識庫 kb-confidential.*機密等級是 confidential，超過這份設定允許的 internal.*max_confidentiality 改成 "confidential"/);
  assert.match(getWikiInfo(dflt), /沒有掛載成功[\s\S]*kb-confidential/);
  assert.match(searchWikiTool(dflt, { terms: ['測試'], kb: 'kb-confidential' }), /沒有「kb-confidential」這個知識庫/);

  assert.deepEqual(new Mounts(all, [], { maxConfidentiality: 'public' }).names(), ['kb-public']);
  assert.deepEqual(new Mounts(all, [], { maxConfidentiality: 'confidential' }).names().length, 3);
});

test('設定檔：remote、max_confidentiality、cache_dir', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ max_confidentiality: 'confidential', cache_dir: 'my-cache', knowledge_bases: [{ path: 'local-kb' }, { remote: 'share/x.git' }, { remote: 'file:///srv/y.git' }, {}] }));
  const r = loadConfig(['--config', cfg], {});
  assert.deepEqual(r.entries, [{ path: path.join(dir, 'local-kb') }, { remote: path.join(dir, 'share', 'x.git') }, { remote: 'file:///srv/y.git' }]);
  assert.deepEqual(r.paths, [path.join(dir, 'local-kb')]);
  assert.equal(r.maxConfidentiality, 'confidential');
  assert.equal(r.cacheDir, path.join(dir, 'my-cache'));
  assert.match(r.problems[0], /沒有 path 也沒有 remote/);

  fs.writeFileSync(cfg, JSON.stringify({ max_confidentiality: 'top-secret', knowledge_bases: [] }));
  const bad = loadConfig(['--config', cfg], { LLM_WIKI_CACHE: path.join(dir, 'env-cache') });
  assert.equal(bad.maxConfidentiality, 'internal');
  assert.match(bad.problems[0], /max_confidentiality 必須是/);
  assert.equal(bad.cacheDir, path.join(dir, 'env-cache'));
});

// ---------------------------------------------------------------------- 維護端

test('share：建立共享儲存庫並推送，說明使用者要怎麼設定', () => {
  const { a, remote } = world({ shared: false });
  assert.match(shareKb(a).text, /沒有指定共享位置/);
  const r = shareKb(a, remote);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已共享到：/);
  assert.match(r.text, /kb mount add ".*share\/shared-kb\.git" --trust/);
  assert.match(r.text, /看不到 kb\.json 與頁面是正常的/);
  assert.match(r.text, /kb clone /);
  assert.ok(fs.existsSync(path.join(remote, 'HEAD')));
  assert.equal(git(remote, ['rev-parse', 'main']).stdout.trim(), head(a));
  assert.deepEqual(remoteStatus(a), { origin: remote, reachable: true, untrusted: false, ahead: 0, behind: 0, error: null });
  // 共享資料夾的路徑只在 git 設定裡，沒有寫進知識庫的內容
  assert.equal(git(a, ['status', '--porcelain']).stdout, '');
  assert.equal(git(a, ['grep', '-l', 'shared-kb.git']).stdout, '');

  assert.match(shareKb(a).text, /已經設定共享位置/);
  assert.match(shareKb(a, path.join(remote, '..', 'other.git')).text, /已經設定共享位置[\s\S]*kb push/);
});

test('share：位置不合適時擋下，且不留下設定', () => {
  const { base, a } = world({ shared: false });
  const occupied = path.join(base, 'occupied');
  put(occupied, 'file.txt', 'x');
  assert.match(shareKb(a, occupied).text, /已經存在，而且不是共享儲存庫/);
  // 那個位置已經是別的知識庫。代號要不同：同一秒內建立的同內容知識庫 commit 會完全相同，推送會被當成已是最新
  const other = world({ name: 'other-kb' });
  const r = shareKb(a, other.remote);
  assert.equal(r.code, 1);
  assert.match(r.text, /已經有別的知識庫的內容[\s\S]*kb clone/);
  assert.equal(remoteStatus(a).origin, null);
  // 有未 commit 的頁面時不共享
  put(a, 'wiki/topic/wip.md', draft());
  assert.match(shareKb(a, path.join(base, 'share', 'x.git')).text, /有尚未 commit 的頁面變更/);
  assert.match(shareKb(makeKb(), 'x').text, /不是 git repo/);
});

test('push／pull／clone：兩位維護者輪流作業', () => {
  const { base, a, remote } = world();
  const b = path.join(base, 'b');
  let r = cloneKb(remote, b);
  assert.equal(r.code, 0, r.text);
  assert.equal(head(b), head(a));
  assert.ok(fs.existsSync(path.join(b, 'wiki', 'topic', 'alpha.md')));

  assert.match(pushKb(a).text, /沒有需要推送的變更/);
  assert.match(pullKb(b).text, /已經是最新的/);

  // 甲做完 ingest，輸出提醒要推送；推送後乙取得
  put(a, 'raw/code.c', RAW_CODE);
  ingestStart(a, 'raw/code.c');
  put(a, 'wiki/topic/code.md', draft({ title: '程式', sources: '\n  - raw/code.c:L1-L3' }));
  r = ingestCommit(a);
  assert.match(r.text, /這個知識庫有共享位置，目前有 1 筆變更尚未推送。這一批都處理完後執行：kb push/);
  r = pushKb(a);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已推送 1 筆變更到：/);

  r = pullKb(b);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已取得 1 筆新變更/);
  assert.equal(head(b), head(a));
  assert.equal(read(b, 'raw/code.c'), RAW_CODE);

  // 乙接著做，推回去，甲取得
  addPage(b, 'from-b');
  assert.equal(pushKb(b).code, 0);
  assert.equal(pullKb(a).code, 0);
  assert.ok(fs.existsSync(path.join(a, 'wiki', 'topic', 'from-b.md')));
});

test('別人先推送了：push 與 ingest start 都要求先 pull', () => {
  const { base, a, remote } = world();
  const b = path.join(base, 'b');
  cloneKb(remote, b);
  addPage(b, 'from-b');
  pushKb(b);

  assert.match(pushKb(a).text, /共享位置有 1 筆別人推送的新變更，要先取得才能推送[\s\S]*kb pull/);
  put(a, 'raw/code.c', RAW_CODE);
  const start = ingestStart(a, 'raw/code.c');
  assert.equal(start.code, 1);
  assert.match(start.text, /共享位置有 1 筆別人推送的新變更[\s\S]*先執行 kb pull 取得，再執行 kb ingest start raw\/code\.c/);
  assert.equal(pullKb(a).code, 0);
  assert.equal(ingestStart(a, 'raw/code.c').code, 0);
});

test('兩邊各自有新變更：不自動合併，說明處理方式且不動任何東西', () => {
  const { base, a, remote } = world();
  const b = path.join(base, 'b');
  cloneKb(remote, b);
  addPage(b, 'from-b');
  pushKb(b);
  addPage(a, 'from-a');
  const before = head(a);

  const push = pushKb(a);
  assert.equal(push.code, 1);
  assert.match(push.text, /要先取得才能推送[\s\S]*兩邊都有變更/);
  const pull = pullKb(a);
  assert.equal(pull.code, 1);
  assert.match(pull.text, /本機與共享位置各自有新的變更（本機 1 筆、共享位置 1 筆），無法自動合併/);
  assert.match(pull.text, /轉告使用者，不要自行處理[\s\S]*kb undo[\s\S]*kb pull[\s\S]*kb ingest/);
  assert.equal(head(a), before);
  assert.equal(git(a, ['status', '--porcelain']).stdout, '');
  assert.ok(fs.existsSync(path.join(a, 'wiki', 'topic', 'from-a.md')));
});

test('pull／push：未 commit 的變更、沒有共享位置、連不到共享位置', () => {
  const { base, a, remote } = world();
  put(a, 'wiki/topic/wip.md', draft());
  assert.match(pullKb(a).text, /有尚未 commit 的頁面變更/);
  fs.rmSync(path.join(a, 'wiki', 'topic', 'wip.md'));

  const solo = world({ shared: false });
  assert.match(pushKb(solo.a).text, /還沒有設定共享位置[\s\S]*kb share/);
  assert.match(pullKb(solo.a).text, /還沒有設定共享位置/);
  assert.equal(remoteStatus(solo.a).origin, null);

  // 共享資料夾連不上
  addPage(a, 'offline-work');
  fs.renameSync(remote, `${remote}.gone`);
  assert.match(pushKb(a).text, /連不到共享位置[\s\S]*本機的變更都還在/);
  assert.match(pullKb(a).text, /連不到共享位置/);
  // 離線時仍可繼續 ingest，只是提醒
  put(a, 'raw/code.c', RAW_CODE);
  const start = ingestStart(a, 'raw/code.c');
  assert.equal(start.code, 0);
  assert.match(start.text, /連不到共享位置，無法確認別人有沒有推送新變更/);
  assert.match(cloneKb(path.join(base, 'nope.git'), path.join(base, 'c')).text, /無法從.*取得知識庫/);
});

test('clone：參數與目標檢查', () => {
  const { base, remote } = world();
  assert.match(cloneKb().text, /需要共享位置與本機資料夾/);
  const used = path.join(base, 'used');
  put(used, 'x.txt', 'x');
  assert.match(cloneKb(remote, used).text, /已經存在而且不是空的/);
  // 不是知識庫的儲存庫
  const plain = path.join(base, 'plain.git');
  git(base, ['init', '--quiet', '--bare', plain]);
  const work = path.join(base, 'plain-work');
  fs.mkdirSync(work);
  git(work, ['init', '--quiet', '-b', 'main']);
  put(work, 'readme.txt', 'x');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'x']);
  git(work, ['push', '--quiet', plain, 'main']);
  const target = path.join(base, 'not-kb');
  assert.match(cloneKb(plain, target).text, /不是知識庫（裡面沒有 kb\.json）/);
  assert.equal(fs.existsSync(target), false);
});

// ------------------------------------------------------------------ MCP 端快取

test('快取：第一次下載、之後更新並對齊遠端', async () => {
  const { a, remote, cache } = world();
  const dir = cachePathFor(cache, remote);
  assert.match(path.basename(dir), /^shared-kb-[0-9a-f]{8}$/);
  assert.equal(cachePathFor(cache, remote), dir);
  assert.notEqual(cachePathFor(cache, `${remote}2`), dir);
  assert.equal(readSyncInfo(dir), null);

  assert.deepEqual(await syncRemote(remote, dir), { ok: true, error: null, untrusted: false });
  assert.equal(head(dir), head(a));
  const first = readSyncInfo(dir);
  assert.equal(first.remote, remote);
  assert.ok(Date.parse(first.synced) > 0);

  // 快取被亂動也會被對齊回遠端的內容
  addPage(a, 'second');
  pushKb(a);
  put(dir, 'wiki/topic/alpha.md', '被改壞');
  put(dir, 'wiki/topic/stray.md', '多出來的檔案');
  assert.deepEqual(await syncRemote(remote, dir), { ok: true, error: null, untrusted: false });
  assert.equal(head(dir), head(a));
  assert.equal(read(dir, 'wiki/topic/alpha.md'), read(a, 'wiki/topic/alpha.md'));
  assert.equal(fs.existsSync(path.join(dir, 'wiki', 'topic', 'stray.md')), false);
  assert.ok(fs.existsSync(path.join(dir, 'wiki', 'topic', 'second.md')));
});

test('快取：連不到遠端時回報失敗，既有快取保持原狀', async () => {
  const { remote, cache } = world();
  const dir = cachePathFor(cache, remote);
  await syncRemote(remote, dir);
  const before = head(dir);
  const info = readSyncInfo(dir);
  fs.renameSync(remote, `${remote}.gone`);
  const r = await syncRemote(remote, dir);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
  assert.equal(head(dir), before);
  assert.deepEqual(readSyncInfo(dir), info);
  // 沒有快取時失敗：不留下半套資料夾
  const fresh = cachePathFor(cache, `${remote}.nope`);
  assert.equal((await syncRemote(`${remote}.nope`, fresh)).ok, false);
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.includes('tmp') || n.startsWith('shared-kb.git.nope')), []);
});

test('掛載共享知識庫：下載前、下載後、有新內容、離線', async () => {
  const { a, remote, cache } = world();
  const m = new Mounts([{ remote }, { path: SAMPLE_KB }], [], { cacheDir: cache, maxConfidentiality: 'internal' });
  // 還沒下載：本機知識庫照常可用，共享的標示為下載中
  assert.deepEqual(m.names(), ['sample-uart']);
  assert.match(getWikiInfo(m), /正在第一次下載到本機快取，稍後再呼叫一次 GetWikiInfo/);

  await m.syncAll();
  assert.deepEqual(m.names(), ['shared-kb', 'sample-uart']);
  const info = getWikiInfo(m);
  assert.match(info, /代號 shared-kb｜共享知識庫｜分類 test｜1 頁｜共享（本機快取更新於 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  assert.doesNotMatch(info, /沒有掛載成功|正在檢查更新/);
  assert.match(info, /代號 sample-uart｜DB1 UART 範例知識庫｜分類 driver｜12 頁\n/);
  assert.match(readWiki(m, { kb: 'shared-kb', pages: ['topic/alpha'] }), /標題：阿法/);
  // 讀的是快取，不是共享資料夾，也不是維護者的工作複本
  assert.equal(m.get('shared-kb').root, cachePathFor(cache, remote));

  // 維護者推送新內容 → 下次啟動（新的 Mounts）先用舊快取，同步後看到新內容
  addPage(a, 'newpage');
  pushKb(a);
  const m2 = new Mounts([{ remote }], [], { cacheDir: cache });
  assert.match(getWikiInfo(m2), /1 頁｜共享（本機快取更新於 .*，正在檢查更新）/);
  await m2.syncAll();
  assert.match(getWikiInfo(m2), /2 頁｜共享（本機快取更新於 [^，]*）\n/);
  assert.match(searchWikiTool(m2, { terms: ['newpage'] }), /頁面 topic\/newpage/);

  // 離線：沿用快取，並註明
  fs.renameSync(remote, `${remote}.gone`);
  const m3 = new Mounts([{ remote }], [], { cacheDir: cache });
  await m3.syncAll();
  assert.deepEqual(m3.names(), ['shared-kb']);
  const offline = getWikiInfo(m3);
  assert.match(offline, /2 頁｜共享（本機快取更新於 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  assert.match(offline, /注意：這次無法從共享資料夾更新（.+），目前使用的是本機快取，內容可能不是最新的。/);
  assert.match(readWiki(m3, { pages: ['topic/newpage'] }), /標題：newpage/);
});

test('使用中自動更新：距離上次更新超過間隔，呼叫工具時在背景更新', async () => {
  const { a, remote, cache } = world();
  const MINUTE = 60 * 1000;
  let clock = 1_000_000;
  const synced = [];
  const m = new Mounts([{ remote }], [], { cacheDir: cache, now: () => clock, onBackgroundSync: (e) => synced.push(e ?? 'ok') });
  // 啟動時的第一次更新還沒做之前，呼叫工具不會自己去更新
  clock += 60 * MINUTE;
  getWikiInfo(m);
  assert.equal(m.backgroundSync, null);
  await m.syncAll();
  assert.match(getWikiInfo(m), /1 頁｜共享/);

  addPage(a, 'later');
  pushKb(a);
  // 還沒到間隔：不更新，內容維持舊的
  clock += (LIMITS.sharedSyncIntervalMinutes - 1) * MINUTE;
  assert.match(getWikiInfo(m), /1 頁｜共享/);
  assert.equal(m.backgroundSync, null);

  // 超過間隔：這次呼叫發起更新但不等它；更新期間再呼叫不會重複發起
  clock += 2 * MINUTE;
  assert.match(getWikiInfo(m), /1 頁｜共享（本機快取更新於 .*，正在檢查更新）/);
  const running = m.backgroundSync;
  assert.ok(running);
  getWikiInfo(m);
  assert.equal(m.backgroundSync, running);
  await running;
  assert.deepEqual(synced, ['ok']);
  assert.equal(m.backgroundSync, null);
  assert.match(getWikiInfo(m), /2 頁｜共享（本機快取更新於 [^，]*）\n/);
  assert.match(searchWikiTool(m, { terms: ['later'] }), /頁面 topic\/later/);

  // 共享資料夾連不上：沿用快取並註明，下一個間隔會再試
  fs.renameSync(remote, `${remote}.gone`);
  clock += (LIMITS.sharedSyncIntervalMinutes + 1) * MINUTE;
  getWikiInfo(m);
  await m.backgroundSync;
  assert.match(getWikiInfo(m), /2 頁｜共享[\s\S]*這次無法從共享資料夾更新/);
  fs.renameSync(`${remote}.gone`, remote);
  clock += (LIMITS.sharedSyncIntervalMinutes + 1) * MINUTE;
  getWikiInfo(m);
  await m.backgroundSync;
  assert.doesNotMatch(getWikiInfo(m), /這次無法從共享資料夾更新/);

  // 只有本機知識庫時不會發起更新
  const local = new Mounts([{ path: SAMPLE_KB }], [], { now: () => clock });
  await local.syncAll();
  clock += 999 * MINUTE;
  getWikiInfo(local);
  assert.equal(local.backgroundSync, null);
});

test('掛載共享知識庫：連不上又沒有快取、機密等級不允許', async () => {
  const { remote, cache } = world();
  const gone = new Mounts([{ remote: `${remote}.nope` }], [], { cacheDir: cache });
  await gone.syncAll();
  assert.deepEqual(gone.names(), []);
  assert.match(gone.problems[0], /沒有掛載：無法從共享資料夾下載，本機也沒有快取/);
  assert.match(getWikiInfo(gone), /目前沒有掛載任何知識庫[\s\S]*無法從共享資料夾下載/);

  const strict = new Mounts([{ remote }], [], { cacheDir: cache, maxConfidentiality: 'public' });
  await strict.syncAll();
  assert.deepEqual(strict.names(), []);
  assert.match(strict.problems[0], /知識庫 shared-kb（共享知識庫 .*）沒有掛載：它的機密等級是 internal，超過這份設定允許的 public/);
});

// ------------------------------------------------------------------- 端到端

test('端到端：MCP server 依設定檔掛載共享與本機知識庫，背景下載後可檢索', async () => {
  const { base, remote, cache } = world();
  const cfg = path.join(base, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ cache_dir: cache, knowledge_bases: [{ remote }, { path: SAMPLE_KB }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO_ROOT, 'src', 'mcp', 'server.js'), '--config', cfg], stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
    let info = '';
    for (let i = 0; i < 100; i++) {
      info = await call('GetWikiInfo', {});
      if (/代號 shared-kb/.test(info) && !/正在檢查更新/.test(info)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(info, /已掛載 2 個知識庫/);
    assert.match(info, /代號 shared-kb｜共享知識庫｜分類 test｜1 頁｜共享（本機快取更新於 /);
    assert.match(await call('ReadWiki', { kb: 'shared-kb', pages: ['topic/alpha'] }), /標題：阿法/);
    assert.match(await call('FetchRaw', { kb: 'shared-kb', path: 'raw/spec.md#2.1' }), /2\.1 暫存器/);
  } finally {
    await client.close();
  }
});

test('CLI：share、push、pull、clone', () => {
  const { base, a } = world({ shared: false });
  const remote = path.join(base, 'cli-share', 'kb.git');
  const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  assert.equal(run(a, 'push').status, 1);
  let r = run(a, 'share', remote);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已共享到/);
  const b = path.join(base, 'b');
  r = run(base, 'clone', remote, b);
  assert.equal(r.status, 0, r.stderr);
  addPage(a, 'more');
  assert.match(run(a, 'push').stdout, /已推送 1 筆變更/);
  assert.match(run(b, 'pull').stdout, /已取得 1 筆新變更/);
  assert.match(run(b, 'pull').stdout, /已經是最新的/);
});
