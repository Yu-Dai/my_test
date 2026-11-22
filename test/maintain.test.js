import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildSearchIndex, checkKb, editCommit, findUndoTarget, git, ingestAbort, ingestCommit, ingestStart, initKb, lintKb, loadKb,
  queryTestAdd, queryTestRemove, queryTestRun, readProvenance, readQueryTests, runQueryTests, today, undoLast,
} from '../src/core/index.js';
import { CLI, RAW_CODE, RAW_SPEC, SAMPLE_KB, makeKb, makePage } from './helpers.js';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' });

const FIELDS = { name: 'test-kb', title: '測試知識庫', description: '測試用', owner: 'tester', category: 'test', confidentiality: 'public' };
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const commits = (root) => git(root, ['log', '--format=%s']).stdout.trim().split('\n');
const status = (root) => git(root, ['status', '--porcelain']).stdout.trim();
const draft = (fm = {}, body) => makePage({ updated: undefined, sources: '\n  - raw/spec.md#2.1', ...fm }, body);
const linked = (other) => `## 內容\n\n見 [[${other}]]。\n\n## 相關頁面\n\n## 來源\n`;
const codes = (issues, level) => issues.filter((i) => i.level === level).map((i) => i.code).sort();

/** 已經 ingest 過 raw/spec.md、有 alpha 與 beta 兩頁互相連結的知識庫。 */
function seededKb() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-maint-')), 'kb');
  assert.equal(initKb(root, FIELDS).code, 0);
  put(root, 'raw/spec.md', RAW_SPEC);
  ingestStart(root, 'raw/spec.md');
  put(root, 'wiki/topic/alpha.md', draft({ title: '阿法', keywords: '[阿法, alpha]' }, linked('topic/beta')));
  put(root, 'wiki/topic/beta.md', draft({ title: '貝塔', keywords: '[貝塔, beta]' }, linked('topic/alpha')));
  const r = ingestCommit(root);
  assert.equal(r.code, 0, r.text);
  return root;
}

// ----------------------------------------------------------------- query test

test('query test：範例知識庫的題目全部通過', () => {
  const { tests, error } = readQueryTests(SAMPLE_KB);
  assert.equal(error, null);
  assert.ok(tests.length >= 5);
  const results = runQueryTests(buildSearchIndex(loadKb(SAMPLE_KB)), tests);
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.match(queryTestRun(SAMPLE_KB).text, new RegExp(`結果：${tests.length} 題全部通過。`));
});

test('query test：排名不夠前面或搜尋不到就失敗', () => {
  const index = buildSearchIndex(loadKb(SAMPLE_KB));
  const [far, none, ok] = runQueryTests(index, [
    { terms: ['uart'], expect: ['gpio/pin-mux'], max_rank: 1 },
    { terms: ['量子糾纏'], expect: ['uart/baud-rate'], max_rank: 5 },
    { terms: ['波特率'], expect: ['uart/baud-rate'], max_rank: 1 },
  ]);
  assert.equal(far.ok, false);
  assert.ok(far.ranks[0].rank > 1);
  assert.equal(none.ok, false);
  assert.equal(none.ranks[0].rank, null);
  assert.equal(ok.ok, true);
});

test('query test：檔案格式錯誤時回報', () => {
  for (const content of ['{', '{}', '{"tests":[{"terms":[],"expect":["a/b"],"max_rank":1}]}', '{"tests":[{"terms":["x"],"expect":["Bad"],"max_rank":1}]}', '{"tests":[{"terms":["x"],"expect":["a/b"]}]}']) {
    const root = makeKb({ '.kb/query-tests.json': content });
    assert.ok(readQueryTests(root).error, content);
    assert.equal(queryTestRun(root).code, 1);
  }
  assert.match(queryTestRun(makeKb()).text, /還沒有檢索測試題[\s\S]*kb test add/);
});

test('test add／remove：寫入檔案並各自做成 commit', () => {
  const root = seededKb();
  const n = commits(root).length;
  let r = queryTestAdd(root, { terms: '阿法， alpha', expect: 'topic/alpha', rank: '1' });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已新增第 1 題：搜尋「阿法、alpha」→ topic\/alpha（目前第 1 名），要求前 1 名。$/);
  assert.equal(queryTestAdd(root, { terms: 'beta', expect: 'topic/beta' }).code, 0);
  assert.deepEqual(readQueryTests(root).tests, [{ terms: ['阿法', 'alpha'], expect: ['topic/alpha'], max_rank: 1 }, { terms: ['beta'], expect: ['topic/beta'], max_rank: 5 }]);
  assert.deepEqual(commits(root).slice(0, 2), ['test: add #2 beta', 'test: add #1 阿法,alpha']);
  assert.equal(status(root), '');

  r = queryTestRemove(root, '1');
  assert.equal(r.code, 0);
  assert.match(r.text, /已移除第 1 題[\s\S]*剩下 1 題/);
  assert.deepEqual(readQueryTests(root).tests.map((t) => t.terms), [['beta']]);
  assert.equal(commits(root).length, n + 3);
  assert.equal(status(root), '');
  assert.equal(queryTestRemove(root, 5).code, 1);
});

test('test add：參數錯誤、頁面不存在、現在就不會通過的題目都不新增', () => {
  const root = seededKb();
  assert.match(queryTestAdd(root, { terms: 'x' }).text, /需要 --terms.*與 --expect/);
  assert.match(queryTestAdd(root, { terms: 'x', expect: 'topic/alpha', rank: '0' }).text, /--rank 必須是正整數/);
  assert.match(queryTestAdd(root, { terms: 'x', expect: 'topic/nope' }).text, /沒有這個頁面：topic\/nope/);
  const r = queryTestAdd(root, { terms: '量子糾纏', expect: 'topic/alpha' });
  assert.equal(r.code, 1);
  assert.match(r.text, /這一題現在就不會通過，沒有新增[\s\S]*topic\/alpha 沒有被搜尋到[\s\S]*keywords 或 aliases/);
  assert.deepEqual(readQueryTests(root).tests, []);
  assert.equal(status(root), '');
});

test('檢索退步會擋下 commit，補回關鍵字後通過', () => {
  const root = seededKb();
  queryTestAdd(root, { terms: 'alpha', expect: 'topic/alpha', rank: 1 });
  const original = read(root, 'wiki/topic/alpha.md');
  put(root, 'wiki/topic/alpha.md', original.replace('keywords: [阿法, alpha]', 'keywords: [阿法]'));
  const r = editCommit(root, '拿掉關鍵字');
  assert.equal(r.code, 1);
  assert.match(r.text, /檢索測試沒過。第 1 題：搜尋「alpha」時，topic\/alpha 沒有被搜尋到/);
  assert.match(r.text, /kb test remove 1/);
  assert.match(r.text, /修正後再執行：kb commit "拿掉關鍵字"/);
  assert.match(commits(root)[0], /^test: add/);

  put(root, 'wiki/topic/alpha.md', original.replace('aliases: [別名]', 'aliases: [別名, Alpha 版]'));
  assert.equal(editCommit(root, '補別名').code, 0);
});

// ------------------------------------------------------------------ kb commit

test('kb commit：修改頁面後驗證、蓋 updated、寫 log、做成 edit commit', () => {
  const root = seededKb();
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('updated: ', 'updated: 2000-01-01 #').replace('summary: 一句話摘要', 'summary: 改過的摘要'));
  const r = editCommit(root, '  改寫\n摘要  ');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^已 commit：改寫 摘要\n- 更新 1 頁：topic\/alpha\n- commit：[0-9a-f]+（edit: 改寫 摘要 \[\d{8}-\d{6}-[0-9a-f]{4}\]）/);
  assert.match(read(root, 'wiki/topic/alpha.md'), new RegExp(`\\nupdated: ${today()}\\n`));
  assert.match(read(root, 'index.md'), /改過的摘要/);
  assert.match(read(root, 'log.md'), /\] edit \| 改寫 摘要\n\n- 更新 1 頁：topic\/alpha\n- id：/);
  // edit 不算一次 ingest
  assert.equal(readProvenance(root).sources['raw/spec.md'].ingests.length, 1);
  assert.equal(status(root), '');
  assert.deepEqual(checkKb(root).issues, []);
});

test('kb commit：不允許的狀況', () => {
  const root = seededKb();
  assert.match(editCommit(root, '').text, /需要一句話說明/);
  assert.match(editCommit(root, '沒改東西').text, /wiki\/ 沒有任何變更，沒有東西可以 commit/);
  put(root, 'wiki/topic/alpha.md', draft({ type: 'note' }));
  const bad = editCommit(root, '改壞');
  assert.equal(bad.code, 1);
  assert.match(bad.text, /type 必須是[\s\S]*修正後再執行：kb commit "改壞"/);
  ingestAbort(root);
  // ingest 進行中不能用 kb commit
  put(root, 'raw/code.c', RAW_CODE);
  ingestStart(root, 'raw/code.c');
  assert.match(editCommit(root, 'x').text, /正在處理來源 raw\/code\.c[\s\S]*kb ingest commit/);
});

test('kb commit：刪除頁面後 provenance 的 pages 跟著更新', () => {
  const root = seededKb();
  fs.rmSync(path.join(root, 'wiki', 'topic', 'beta.md'));
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('見 [[topic/beta]]。', '沒有連結了。'));
  const r = editCommit(root, '刪除 beta');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /- 更新 1 頁：topic\/alpha\n- 刪除 1 頁：topic\/beta/);
  assert.deepEqual(readProvenance(root).sources['raw/spec.md'].pages, ['topic/alpha']);
});

// ----------------------------------------------------------------------- lint

test('lint：範例知識庫沒有任何問題', () => {
  assert.deepEqual(lintKb(SAMPLE_KB).issues, []);
});

test('lint：孤立頁面、標題重複、來源狀態、沒用到的圖片', () => {
  const root = seededKb();
  assert.deepEqual(lintKb(root).issues, []);

  put(root, 'raw/code.c', RAW_CODE); // 尚未處理
  put(root, 'assets/unused.png', 'PNG');
  put(root, 'wiki/topic/gamma.md', draft({ title: '阿法' })); // 沒人連到，標題與 alpha 重複
  assert.equal(editCommit(root, '加一頁').code, 0);
  fs.appendFileSync(path.join(root, 'raw', 'spec.md'), '\n新內容\n'); // 處理後有更新

  const { issues } = lintKb(root);
  assert.deepEqual(codes(issues, 'error'), []);
  assert.deepEqual(codes(issues, 'warn'), ['asset-unused', 'orphan-page', 'source-changed', 'source-pending', 'title-duplicate']);
  const by = (code) => issues.find((i) => i.code === code);
  assert.match(by('orphan-page').message, /沒有任何頁面連到 topic\/gamma/);
  assert.match(by('title-duplicate').message, /topic\/alpha、topic\/gamma/);
  assert.match(by('source-changed').message, /這些頁面可能過時：topic\/alpha、topic\/beta、topic\/gamma/);
  assert.equal(by('source-changed').next, '執行：kb ingest start raw/spec.md');
  assert.equal(by('source-pending').file, 'raw/code.c');
  assert.equal(by('asset-unused').file, 'assets/unused.png');
});

test('lint：沒被引用的來源、格式錯誤、檢索測試失敗', () => {
  const root = makeKb({ 'raw/extra.txt': 'x\n', 'assets/pic.png': null, 'assets/.gitkeep': '' });
  spawnSync(process.execPath, [CLI, 'rebuild', '--kb', root]);
  assert.deepEqual(lintKb(root).issues.map((i) => i.code), ['source-uncited']);

  put(root, '.kb/query-tests.json', JSON.stringify({ tests: [{ terms: ['量子'], expect: ['topic/alpha'], max_rank: 1 }] }));
  assert.deepEqual(codes(lintKb(root).issues, 'error'), ['query-test']);

  put(root, 'wiki/topic/alpha.md', makePage({ type: 'note' }));
  // 有格式錯誤時不跑檢索測試，先把格式修好
  assert.deepEqual(codes(lintKb(root).issues, 'error'), ['type']);
});

// ----------------------------------------------------------------------- undo

test('undo：撤銷 ingest，頁面與對應表還原，來源回到待處理，log 保留', () => {
  const root = seededKb();
  put(root, 'raw/code.c', RAW_CODE);
  put(root, 'assets/pic.png', 'PNG');
  ingestStart(root, 'raw/code.c');
  const alphaBefore = read(root, 'wiki/topic/alpha.md');
  put(root, 'wiki/topic/alpha.md', alphaBefore.replace('見 [[topic/beta]]。', '見 [[topic/beta]] 與 [[code/vars]]。\n\n![一張圖](assets/pic.png)'));
  put(root, 'wiki/code/vars.md', draft({ title: '變數', sources: '\n  - raw/code.c:L1-L5' }, linked('topic/alpha')));
  assert.equal(ingestCommit(root).code, 0);
  const id = readProvenance(root).sources['raw/code.c'].ingests[0].id;

  const r = undoLast(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`^已撤銷：ingest: raw/code\\.c \\[${id}\\]\\n- 移除了當時新增的頁面：code/vars\\n- 還原了當時修改的頁面：topic/alpha\\n- commit：`));
  assert.match(r.text, /來源檔 raw\/code\.c 還在 raw\/，現在是待處理狀態。\n重新處理：kb ingest start raw\/code\.c/);

  assert.equal(exists(root, 'wiki/code/vars.md'), false);
  assert.equal(read(root, 'wiki/topic/alpha.md'), alphaBefore);
  assert.equal(readProvenance(root).sources['raw/code.c'], undefined);
  assert.doesNotMatch(read(root, 'index.md'), /code\/vars/);
  // 來源與圖片的檔案留著，但不在版本庫裡了
  assert.equal(read(root, 'raw/code.c'), RAW_CODE);
  assert.ok(exists(root, 'assets/pic.png'));
  assert.equal(status(root), '?? assets/pic.png\n?? raw/code.c');
  // log 只增不改：ingest 的紀錄還在，後面多一筆 undo
  const log = read(root, 'log.md');
  assert.match(log, /\] ingest \| raw\/code\.c\n/);
  assert.match(log, new RegExp(`\\] undo \\| ingest: raw/code\\.c \\[${id}\\]\\n$`));
  assert.equal(commits(root)[0], `undo: ingest: raw/code.c [${id}]`);
  assert.deepEqual(checkKb(root).issues, []);

  // 撤銷後可以重新 ingest
  assert.match(ingestStart(root).text, /- raw\/code\.c（尚未處理）/);
  ingestStart(root, 'raw/code.c');
  put(root, 'wiki/code/vars.md', draft({ title: '變數', sources: '\n  - raw/code.c:L1-L5' }, linked('topic/alpha')));
  assert.equal(ingestCommit(root).code, 0);
});

test('undo：可以連續撤銷，一路退到沒有東西可退', () => {
  const root = seededKb();
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('一句話摘要', '第二版摘要'));
  assert.equal(editCommit(root, '改摘要').code, 0);
  queryTestAdd(root, { terms: 'beta', expect: 'topic/beta' }); // 中間夾一筆 test commit

  assert.match(findUndoTarget(root).subject, /^edit: 改摘要/);
  assert.match(undoLast(root).text, /^已撤銷：edit: 改摘要/);
  assert.match(read(root, 'wiki/topic/alpha.md'), /summary: 一句話摘要/);
  assert.match(findUndoTarget(root).subject, /^ingest: raw\/spec\.md/);

  const r = undoLast(root);
  assert.match(r.text, /^已撤銷：ingest: raw\/spec\.md[\s\S]*移除了當時新增的頁面：topic\/alpha、topic\/beta/);
  assert.equal(exists(root, 'wiki/topic/alpha.md'), false);
  assert.deepEqual(readProvenance(root).sources, {});
  assert.equal(findUndoTarget(root), null);
  assert.match(undoLast(root).text, /沒有可以撤銷的變更/);
  // 題目指到的頁面已不存在，lint 會指出來
  assert.deepEqual(codes(lintKb(root).issues, 'error'), ['query-test']);
});

test('undo：有未 commit 的變更或 ingest 進行中時不執行', () => {
  const root = seededKb();
  put(root, 'wiki/topic/alpha.md', '改到一半');
  assert.match(undoLast(root).text, /有尚未 commit 的變更：wiki\/topic\/alpha\.md/);
  ingestAbort(root);
  put(root, 'raw/code.c', RAW_CODE);
  ingestStart(root, 'raw/code.c');
  assert.match(undoLast(root).text, /目前有來源正在處理中/);
  assert.equal(commits(root).length, 2);
  assert.match(undoLast(makeKb()).text, /不是 git repo/);
});

test('undo：後來的變更改到同樣的檔案時，放棄撤銷且不留下半套狀態', () => {
  const root = seededKb();
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('一句話摘要', '第二版'));
  editCommit(root, '第二版');
  const head = git(root, ['rev-parse', 'HEAD']).stdout;
  // 手動製造一筆不是 kb 做的 commit，改到同一行
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('第二版', '手動改的第三版'));
  git(root, ['commit', '-qam', 'manual change']);
  const r = undoLast(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /無法自動撤銷「edit: 第二版/);
  assert.equal(status(root), '');
  assert.match(read(root, 'wiki/topic/alpha.md'), /手動改的第三版/);
  assert.notEqual(git(root, ['rev-parse', 'HEAD']).stdout, head);
  assert.equal(commits(root)[0], 'manual change');
});

// ------------------------------------------------------------------------ CLI

test('CLI：commit、lint、test、undo、rebuild', () => {
  const root = seededKb();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run('lint').status, 0);
  assert.match(run('lint').stdout, /結果：合格[\s\S]*內容檢查/);
  assert.equal(run('test', 'add', '--terms', '阿法,alpha', '--expect', 'topic/alpha', '--rank', '1').status, 0);
  assert.match(run('test').stdout, /通過 第 1 題[\s\S]*1 題全部通過/);
  assert.equal(run('test', 'bogus').status, 2);

  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('一句話摘要', '新摘要'));
  let r = run('commit', '改', '摘要');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已 commit：改 摘要/);
  r = run('undo');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已撤銷：edit: 改 摘要/);
  assert.equal(run('commit').status, 1);

  // rebuild：索引被弄壞時重建並 commit
  put(root, 'index.md', '壞掉');
  git(root, ['commit', '-qam', 'break index']);
  assert.equal(run('check').status, 1);
  r = run('rebuild');
  assert.match(r.stdout, /已重建：index\.md（共 2 頁）\n已 commit：rebuild: index/);
  assert.equal(run('check').status, 0);
  assert.equal(status(root), '');
  assert.match(run('rebuild').stdout, /沒有變更/);
});
