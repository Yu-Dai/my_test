import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  LIMITS, checkKb, git, hashFile, ingestAbort, ingestCommit, ingestPart, ingestStart, ingestStatus, initKb,
  lintKb, pendingSources, readProvenance, stampUpdated, today,
} from '../src/core/index.js';
import { CLI, RAW_CODE, RAW_SPEC, makePage } from './helpers.js';

// 測試用的 git 身分，不依賴這台機器的設定
Object.assign(process.env, { GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' });

const FIELDS = { name: 'test-kb', title: '測試知識庫', description: '測試用', owner: 'tester', category: 'test', confidentiality: 'public' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-ingest-'));
const put = (root, rel, content) => {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const commits = (root) => git(root, ['log', '--format=%s']).stdout.trim().split('\n');
const draft = (fm = {}, body) => makePage({ updated: undefined, sources: '\n  - raw/spec.md#2.1', ...fm }, body);

/** 建好知識庫並放進兩份來源。 */
function newKb() {
  const root = path.join(tmp(), 'kb');
  const r = initKb(root, FIELDS);
  assert.equal(r.code, 0, r.text);
  put(root, 'raw/spec.md', RAW_SPEC);
  put(root, 'raw/code.c', RAW_CODE);
  return root;
}

// ----------------------------------------------------------------------- init

test('init：建立結構、kb.json、SCHEMA.md、git repo，且整庫檢查合格', () => {
  const root = path.join(tmp(), 'kb');
  const r = initKb(root, FIELDS);
  assert.equal(r.code, 0);
  assert.match(r.text, /kb ingest start/);
  for (const f of ['kb.json', 'SCHEMA.md', 'index.md', 'log.md', '.gitattributes', '.gitignore', '.kb/provenance.json', '.kb/search-index.json', '.kb/query-tests.json', 'raw/.gitkeep', 'wiki/.gitkeep', 'assets/.gitkeep']) {
    assert.ok(fs.existsSync(path.join(root, ...f.split('/'))), f);
  }
  assert.deepEqual(JSON.parse(read(root, 'kb.json')), { ...FIELDS, schema_version: 1, confidentiality: 'public' });
  assert.match(read(root, 'SCHEMA.md'), /^# 測試知識庫：維護規則/);
  assert.doesNotMatch(read(root, 'SCHEMA.md'), /\{\{/);
  assert.match(read(root, 'log.md'), new RegExp(`## \\[${today()}\\] init \\| test-kb`));
  assert.deepEqual(commits(root), ['init: test-kb']);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.deepEqual(checkKb(root).issues, []);
});

test('init：缺欄位、欄位不合格、資料夾非空都擋下且不建立任何東西', () => {
  const root = path.join(tmp(), 'kb');
  const missing = initKb(root, { name: 'x' });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /缺少欄位：--title、--description、--owner、--category、--confidentiality/);
  assert.match(missing.text, /不要自己編/);
  assert.match(initKb(root, { ...FIELDS, name: 'Test KB' }).text, /name 必須是小寫英數加連字號/);
  assert.match(initKb(undefined, FIELDS).text, /沒有指定要建立知識庫的資料夾/);
  assert.equal(fs.existsSync(root), false);
  const used = tmp();
  put(used, 'something.txt', 'x');
  assert.match(initKb(used, FIELDS).text, /已經存在而且不是空的/);
  assert.deepEqual(fs.readdirSync(used), ['something.txt']);
});

// ---------------------------------------------------------------------- start

test('ingest start：不給來源時列出待處理的來源', () => {
  const root = newKb();
  const r = ingestStart(root);
  assert.equal(r.code, 0);
  assert.match(r.text, /還有 2 份來源待處理/);
  assert.match(r.text, /處理下一份：kb ingest start raw\/code\.c/);
  const empty = path.join(tmp(), 'kb');
  initKb(empty, FIELDS);
  assert.match(ingestStart(empty).text, /raw\/ 是空的/);
});

test('ingest start：擋下不合格的來源並提示怎麼處理', () => {
  const root = newKb();
  put(root, 'raw/doc.pdf', '%PDF');
  put(root, 'raw/bin.txt', Buffer.from([1, 0, 2]));
  put(root, 'raw/big5.txt', Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]));
  const cases = [['raw/doc.pdf', /轉成 \.md[\s\S]*圖片資料夾/], ['raw/bin.txt', /二進位/], ['raw/big5.txt', /不是 UTF-8/], ['raw/nope.md', /找不到來源檔[\s\S]*raw\/spec\.md/], ['raw/../kb.json', /不合法/]];
  for (const [src, re] of cases) {
    const r = ingestStart(root, src);
    assert.equal(r.code, 1, src);
    assert.match(r.text, re, src);
  }
  assert.match(ingestStatus(root).text, /目前沒有正在處理的來源/);
  const notRepo = tmp();
  put(notRepo, 'kb.json', '{}');
  assert.match(ingestStart(notRepo, 'raw/a.md').text, /不是 git repo/);
});

test('ingest start：輸出包含步驟、範本、章節、帶行數的來源內容', () => {
  const root = newKb();
  const r = ingestStart(root, 'spec.md');
  assert.equal(r.code, 0);
  assert.match(r.text, /^開始處理來源：raw\/spec\.md（共 15 行，分 1 段）/);
  assert.match(r.text, /== 你要做的事 ==[\s\S]*kb ingest commit/);
  assert.match(r.text, /raw\/spec\.md#章節編號或標題/);
  assert.match(r.text, /== 頁面範本 ==\n---\ntitle:/);
  assert.match(r.text, /== 來源的章節 ==[\s\S]* {4}- 2\.1 暫存器（第 9 行）/);
  assert.match(r.text, /\n {4}9 {2}### 2\.1 暫存器\n/);
  assert.match(r.text, /下一步：在 wiki\/ 寫好頁面後執行 kb ingest commit。$/);
  // 程式碼來源：引用寫法改成行數，沒有章節
  ingestAbort(root);
  const code = ingestStart(root, 'raw/code.c').text;
  assert.match(code, /raw\/code\.c:L起-L迄（行數看來源內容左邊的數字）/);
  assert.doesNotMatch(code, /== 來源的章節 ==/);
});

test('ingest start：一次只能處理一份來源；同一份可以重新 start', () => {
  const root = newKb();
  assert.equal(ingestStart(root, 'raw/spec.md').code, 0);
  const other = ingestStart(root, 'raw/code.c');
  assert.equal(other.code, 1);
  assert.match(other.text, /上一份來源 raw\/spec\.md 還沒處理完[\s\S]*kb ingest abort/);
  assert.equal(ingestStart(root, 'raw/spec.md').code, 0);
  assert.match(ingestStart(root).text, /目前正在處理：raw\/spec\.md/);
});

test('ingest part：長來源分段讀取', () => {
  const root = newKb();
  const n = LIMITS.ingestPartLines * 2 + 10;
  put(root, 'raw/long.txt', Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n'));
  assert.match(ingestPart(root, 1).text, /先執行：kb ingest start/);
  const start = ingestStart(root, 'raw/long.txt').text;
  assert.match(start, new RegExp(`共 ${n} 行，分 3 段`));
  assert.match(start, /其餘用 kb ingest part 2 … kb ingest part 3 讀取/);
  assert.match(start, /下一步：kb ingest part 2 讀取下一段（共 3 段）。$/);
  assert.doesNotMatch(start, new RegExp(`line ${LIMITS.ingestPartLines + 1}\\n`));
  const p2 = ingestPart(root, '2').text;
  assert.match(p2, new RegExp(`第 2/3 段（第 ${LIMITS.ingestPartLines + 1}-${LIMITS.ingestPartLines * 2} 行`));
  assert.match(p2, /下一步：kb ingest part 3/);
  assert.match(ingestPart(root, 3).text, new RegExp(`line ${n}\\n\\n下一步：來源已全部讀完`));
  assert.equal(ingestPart(root, 4).code, 1);
});

// --------------------------------------------------------------------- commit

test('ingest commit：通過後蓋 updated、更新索引與對應表與 log，做成一筆 commit', () => {
  const root = newKb();
  ingestStart(root, 'raw/spec.md');
  put(root, 'wiki/topic/alpha.md', `﻿${draft({}, '## 內容\n\n見 [[topic/beta]]。\n\n## 相關頁面\n\n## 來源\n').replace(/\n/g, '\r\n')}`);
  put(root, 'wiki/topic/beta.md', draft({ title: '貝塔', updated: '1999-01-01' }));
  const r = ingestCommit(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^ingest 完成：raw\/spec\.md\n- 新增 2 頁：topic\/alpha、topic\/beta\n- commit：[0-9a-f]{7,}（ingest: raw\/spec\.md \[\d{8}-\d{6}-[0-9a-f]{4}\]）/);
  assert.match(r.text, /還有 1 份來源待處理：\n- raw\/code\.c（尚未處理）\n處理下一份：kb ingest start raw\/code\.c/);

  // updated 由腳本寫入；BOM 與 CRLF 被統一
  const alpha = read(root, 'wiki/topic/alpha.md');
  assert.match(alpha, new RegExp(`\\nupdated: ${today()}\\n---\\n`));
  assert.ok(!alpha.includes('\r') && !alpha.startsWith('﻿'));
  assert.match(read(root, 'wiki/topic/beta.md'), new RegExp(`\\nupdated: ${today()}\\n`));
  assert.doesNotMatch(read(root, 'wiki/topic/beta.md'), /1999/);

  assert.match(read(root, 'index.md'), /- \[\[topic\/beta\]\] 貝塔 — /);
  assert.match(read(root, 'log.md'), new RegExp(`## \\[${today()}\\] ingest \\| raw/spec\\.md\\n\\n- 新增 2 頁：topic/alpha、topic/beta\\n- id：`));
  const prov = readProvenance(root);
  const entry = prov.sources['raw/spec.md'];
  assert.equal(entry.hash, hashFile(path.join(root, 'raw', 'spec.md')));
  assert.deepEqual(entry.pages, ['topic/alpha', 'topic/beta']);
  assert.deepEqual(entry.ingests.map((i) => [i.created, i.updated, i.deleted]), [[['topic/alpha', 'topic/beta'], [], []]]);

  // 一筆 commit，commit 訊息帶 ingest id；另一份來源沒有被帶進去
  const log = commits(root);
  assert.equal(log.length, 2);
  assert.equal(log[0], `ingest: raw/spec.md [${entry.ingests[0].id}]`);
  assert.equal(git(root, ['status', '--porcelain']).stdout.trim(), '?? raw/code.c');
  assert.deepEqual(checkKb(root).issues, []);
  assert.equal(fs.existsSync(path.join(root, '.kb', 'ingest-state.json')), false);
});

test('ingest commit：驗證沒過就不 commit，檔案原封不動，修正後可通過', () => {
  const root = newKb();
  ingestStart(root, 'raw/spec.md');
  const bad = draft({ type: 'note' }, '## 內容\n\n[[nope]] [[topic/missing]]\n\n## 來源\n');
  put(root, 'wiki/topic/alpha.md', bad);
  const r = ingestCommit(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /type 必須是/);
  assert.match(r.text, /缺少段落「相關頁面」/);
  assert.match(r.text, /連結 \[\[nope\]\] 寫法不對/);
  assert.match(r.text, /連結 \[\[topic\/missing\]\] 指到不存在的頁面/);
  assert.match(r.text, /沒有 commit。頁面檔案都還在/);
  assert.doesNotMatch(r.text, /kb validate/);
  assert.equal(read(root, 'wiki/topic/alpha.md'), bad);
  assert.equal(commits(root).length, 1);
  assert.deepEqual(readProvenance(root).sources, {});
  assert.doesNotMatch(read(root, 'log.md'), /ingest/);

  put(root, 'wiki/topic/alpha.md', draft());
  assert.equal(ingestCommit(root).code, 0);
  assert.equal(commits(root).length, 2);
});

test('ingest commit：各種不允許的狀況', () => {
  const root = newKb();
  assert.match(ingestCommit(root).text, /目前沒有正在處理的來源/);
  ingestStart(root, 'raw/spec.md');
  assert.match(ingestCommit(root).text, /wiki\/ 沒有任何變更，還沒有寫頁面/);

  // 沒有任何頁面引用這份來源
  put(root, 'wiki/topic/alpha.md', draft({ sources: '\n  - raw/code.c:L1-L2' }));
  assert.match(ingestCommit(root).text, /沒有任何一頁在 sources 引用 raw\/spec\.md/);
  put(root, 'wiki/topic/alpha.md', draft());

  // 手動改了只能由腳本寫的檔案
  fs.appendFileSync(path.join(root, 'log.md'), '\n手動加的\n');
  put(root, '.kb/provenance.json', '{}');
  const prot = ingestCommit(root);
  assert.match(prot.text, /不可以手動修改：.*log\.md/);
  assert.match(prot.text, /\.kb\/provenance\.json/);
  assert.match(prot.text, /git checkout HEAD -- /);
  git(root, ['checkout', 'HEAD', '--', 'log.md', '.kb/provenance.json']);

  // 圖片太大
  put(root, 'assets/huge.png', Buffer.alloc(LIMITS.imageMaxBytes + 1, 1));
  assert.match(ingestCommit(root).text, /assets\/huge\.png：圖片 \d+ KB，超過上限/);
  fs.rmSync(path.join(root, 'assets', 'huge.png'));

  assert.equal(ingestCommit(root).code, 0);
  assert.equal(commits(root).length, 2);
});

test('ingest commit：第二份來源可以修改既有頁面；已處理的來源不可再改', () => {
  const root = newKb();
  ingestStart(root, 'raw/spec.md');
  put(root, 'wiki/topic/alpha.md', draft());
  put(root, 'wiki/topic/old.md', draft({ title: '舊頁' }));
  assert.equal(ingestCommit(root).code, 0);

  const start = ingestStart(root, 'raw/code.c');
  assert.equal(start.code, 0);
  assert.match(start.text, /== 現有分類 ==\ntopic/);
  // 修改既有頁面（加上新來源）、新增一頁、刪除一頁
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('  - raw/spec.md#2.1', '  - raw/spec.md#2.1\n  - raw/code.c:L1-L3').replace('updated: ', 'updated: 2000-01-01 #'));
  put(root, 'wiki/code/vars.md', draft({ title: '變數', sources: '\n  - raw/code.c:L1-L5' }));
  fs.rmSync(path.join(root, 'wiki', 'topic', 'old.md'));
  assert.match(ingestStatus(root).text, /正在處理：raw\/code\.c[\s\S]*wiki\/code\/vars\.md（新增）[\s\S]*wiki\/topic\/alpha\.md（修改）[\s\S]*wiki\/topic\/old\.md（刪除）/);

  // 動到已處理過的來源會被擋
  fs.appendFileSync(path.join(root, 'raw', 'spec.md'), '\n偷改\n');
  const edited = ingestCommit(root);
  assert.match(edited.text, /raw\/ 裡的來源檔不可以修改或刪除：raw\/spec\.md/);
  git(root, ['checkout', 'HEAD', '--', 'raw/spec.md']);

  const r = ingestCommit(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /- 新增 1 頁：code\/vars\n- 更新 1 頁：topic\/alpha\n- 刪除 1 頁：topic\/old/);
  assert.match(r.text, /raw\/ 裡的來源都已經處理完了。/);
  const prov = readProvenance(root);
  assert.deepEqual(prov.sources['raw/code.c'].pages, ['code/vars', 'topic/alpha']);
  assert.deepEqual(prov.sources['raw/spec.md'].pages, ['topic/alpha']);
  assert.deepEqual(prov.sources['raw/code.c'].ingests[0].deleted, ['topic/old']);
  assert.equal(commits(root).length, 3);
  assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  assert.deepEqual(checkKb(root).issues, []);
});

test('來源更新後列為待處理，重新 ingest 時提示已引用的頁面', () => {
  const root = newKb();
  fs.rmSync(path.join(root, 'raw', 'code.c'));
  ingestStart(root, 'raw/spec.md');
  put(root, 'wiki/topic/alpha.md', draft());
  ingestCommit(root);
  assert.deepEqual(pendingSources(root, ['raw/spec.md'], readProvenance(root)), []);
  assert.match(ingestStart(root, 'raw/spec.md').text, /之前處理過，而且內容沒有變/);
  ingestAbort(root);

  fs.appendFileSync(path.join(root, 'raw', 'spec.md'), '\n## 新章節\n\n新內容\n');
  assert.match(ingestStart(root).text, /- raw\/spec\.md（內容有更新）/);
  const start = ingestStart(root, 'raw/spec.md').text;
  assert.match(start, /現在內容有更新/);
  assert.match(start, /- topic\/alpha｜測試頁｜一句話摘要【已引用這份來源】/);
  put(root, 'wiki/topic/alpha.md', read(root, 'wiki/topic/alpha.md').replace('  - raw/spec.md#2.1', '  - raw/spec.md#2.1\n  - raw/spec.md#新章節'));
  const r = ingestCommit(root);
  assert.equal(r.code, 0, r.text);
  const entry = readProvenance(root).sources['raw/spec.md'];
  assert.equal(entry.ingests.length, 2);
  assert.notEqual(entry.ingests[0].hash, entry.ingests[1].hash);
  assert.equal(entry.hash, entry.ingests[1].hash);
  assert.deepEqual(entry.ingests[1].updated, ['topic/alpha']);
});

// ---------------------------------------------------------------------- abort

test('ingest abort：還原 wiki/，不動 raw/ 與 assets/', () => {
  const root = newKb();
  ingestStart(root, 'raw/spec.md');
  put(root, 'wiki/topic/alpha.md', draft());
  ingestCommit(root);
  const before = read(root, 'wiki/topic/alpha.md');

  ingestStart(root, 'raw/code.c');
  put(root, 'wiki/topic/alpha.md', '亂改');
  put(root, 'wiki/code/new.md', draft());
  put(root, 'assets/pic.png', 'PNG');
  const r = ingestAbort(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已放棄來源 raw\/code\.c 的處理/);
  assert.equal(read(root, 'wiki/topic/alpha.md'), before);
  assert.equal(fs.existsSync(path.join(root, 'wiki', 'code', 'new.md')), false);
  assert.ok(fs.existsSync(path.join(root, 'raw', 'code.c')));
  assert.ok(fs.existsSync(path.join(root, 'assets', 'pic.png')));
  assert.equal(commits(root).length, 2);
  assert.match(ingestAbort(root).text, /沒有需要放棄的內容/);
  assert.equal(ingestStart(root, 'raw/code.c').code, 0);
});

// ----------------------------------------------------------------------- 其他

test('stampUpdated：新增、取代、保留其他內容', () => {
  assert.equal(stampUpdated('---\ntitle: a\n---\n\n內文\n', '2026-01-02'), '---\ntitle: a\nupdated: 2026-01-02\n---\n\n內文\n');
  assert.equal(stampUpdated('---\nupdated: 2000-01-01\ntitle: a\n---\n內文', '2026-01-02'), '---\nupdated: 2026-01-02\ntitle: a\n---\n內文\n');
  assert.equal(stampUpdated('---\ntitle: a\n---\nupdated: 內文裡的不動\n', '2026-01-02'), '---\ntitle: a\nupdated: 2026-01-02\n---\nupdated: 內文裡的不動\n');
  assert.equal(stampUpdated('沒有開頭欄位', '2026-01-02'), '沒有開頭欄位');
});

test('CLI：init 與 ingest 全流程', () => {
  const root = path.join(tmp(), 'kb');
  const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  let r = run(os.tmpdir(), 'init', root, '--name', 'cli-kb', '--title', 'CLI 測試', '--description', '測試', '--owner', 'me', '--category', 'test', '--confidentiality', 'public');
  assert.equal(r.status, 0, r.stderr);
  put(root, 'raw/spec.md', RAW_SPEC);
  assert.equal(run(root, 'ingest').status, 2);
  assert.match(run(root, 'ingest', 'start').stdout, /raw\/spec\.md（尚未處理）/);
  assert.match(run(root, 'ingest', 'start', 'raw/spec.md').stdout, /開始處理來源/);
  r = run(root, 'ingest', 'commit');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /還沒有寫頁面/);
  put(root, 'wiki/topic/alpha.md', draft());
  r = run(root, 'ingest', 'commit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ingest 完成/);
  assert.match(run(root, 'ingest', 'status').stdout, /都已經處理完了/);
  assert.equal(run(root, 'check').status, 0);
});

// ------------------------------------------------- 轉檔輸出的圖片（.md + 圖片資料夾）

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MANUAL = [
  '# 手冊', '', '## 1 接線', '',
  '![](screenshot/p1.png)', '圖 1：接線圖', '',
  '![設定 視窗](./screenshot/sub/p%202.png "標題") 與 ![](screenshot\\p1.png)', '',
  '<img src="screenshot/p3.JPG" width="300">', '',
  '![外部](https://example.com/x.png) ![已歸檔](assets/old.png) ![不見了](screenshot/gone.png)', '',
  '```', '![](screenshot/in-code.png)', '```', '',
].join('\r\n');

function manualKb() {
  const root = newKb();
  put(root, 'raw/manual.md', MANUAL);
  put(root, 'raw/screenshot/p1.png', PNG);
  put(root, 'raw/screenshot/sub/p 2.png', Buffer.concat([PNG, Buffer.from([2])]));
  put(root, 'raw/screenshot/p3.JPG', Buffer.concat([PNG, Buffer.from([3])]));
  put(root, 'raw/screenshot/in-code.png', PNG);
  return root;
}

test('raw/ 裡的圖片不算來源，也不是錯誤', () => {
  const root = manualKb();
  assert.deepEqual(checkKb(root).issues.filter((i) => i.level === 'error'), []);
  const list = ingestStart(root).text;
  assert.match(list, /還有 3 份來源待處理/);
  assert.doesNotMatch(list, /\.png|\.JPG/);
  const img = ingestStart(root, 'raw/screenshot/p1.png');
  assert.equal(img.code, 1);
  assert.match(img.text, /是圖片，不用單獨處理/);
  const warn = lintKb(root).issues.find((i) => i.code === 'raw-image');
  assert.match(warn.message, /raw\/ 裡有 4 張圖片還沒搬到 assets\//);
});

test('ingest start：把來源引用的圖片搬到 assets/<來源檔名>/ 並改寫路徑', () => {
  const root = manualKb();
  const r = ingestStart(root, 'raw/manual.md');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已把這份來源引用的 3 張圖片搬到 assets\/manual\/，來源內的圖片路徑已改成 assets\/ 開頭。/);
  assert.match(r.text, /找不到檔案：screenshot\/gone\.png/);
  assert.match(r.text, /來源裡有圖片。[\s\S]*說明文字必填/);
  assert.match(r.text, /!\[\]\(assets\/manual\/p1\.png\)/);

  const md = read(root, 'raw/manual.md');
  assert.ok(md.includes('![](assets/manual/p1.png)\r\n圖 1：接線圖'), '保留原本的換行');
  assert.ok(md.includes('![設定 視窗](assets/manual/p-2.png "標題") 與 ![](assets/manual/p1.png)'));
  assert.ok(md.includes('<img src="assets/manual/p3.jpg" width="300">'));
  assert.ok(md.includes('![外部](https://example.com/x.png) ![已歸檔](assets/old.png) ![不見了](screenshot/gone.png)'));
  assert.ok(md.includes('```\r\n![](screenshot/in-code.png)\r\n```'), '程式碼區塊內不改');

  for (const f of ['p1.png', 'p-2.png', 'p3.jpg']) assert.ok(fs.existsSync(path.join(root, 'assets', 'manual', f)), f);
  // 沒被引用的圖留在原地；搬空的子資料夾被移除
  assert.deepEqual(fs.readdirSync(path.join(root, 'raw', 'screenshot')), ['in-code.png']);

  // 再執行一次不會重複搬
  const again = ingestStart(root, 'raw/manual.md');
  assert.doesNotMatch(again.text, /已把這份來源引用的/);
  assert.equal(read(root, 'raw/manual.md'), md);
});

test('ingest commit：搬過去的圖片與改寫後的來源一起 commit，頁面可以引用', () => {
  const root = manualKb();
  fs.rmSync(path.join(root, 'raw', 'screenshot', 'in-code.png'));
  ingestStart(root, 'raw/manual.md');
  put(root, 'wiki/topic/wiring.md', draft({ sources: '\n  - raw/manual.md#1' }, '## 內容\n\n![接線圖](assets/manual/p1.png)\n\n## 相關頁面\n\n## 來源\n'));
  const r = ingestCommit(root);
  assert.equal(r.code, 0, r.text);
  const files = git(root, ['show', '--name-only', '--format=', 'HEAD']).stdout;
  for (const f of ['assets/manual/p1.png', 'assets/manual/p-2.png', 'assets/manual/p3.jpg', 'raw/manual.md', 'wiki/topic/wiring.md']) assert.ok(files.includes(f), f);
  assert.equal(readProvenance(root).sources['raw/manual.md'].hash, hashFile(path.join(root, 'raw', 'manual.md')));
  assert.equal(pendingSources(root, ['raw/manual.md'], readProvenance(root)).length, 0);
});

test('搬圖：不同來源的同名圖片各自一個資料夾；同資料夾內名稱相同而內容不同時加編號', () => {
  const root = newKb();
  put(root, 'raw/a.md', '![](img/x.png) ![](img2/x.png)\n');
  put(root, 'raw/b.md', '![](img/x.png)\n');
  put(root, 'raw/img/x.png', PNG);
  put(root, 'raw/img2/x.png', Buffer.concat([PNG, Buffer.from([9])]));
  ingestStart(root, 'raw/a.md');
  assert.equal(read(root, 'raw/a.md'), '![](assets/a/x.png) ![](assets/a/x-2.png)\n');
  ingestAbort(root);
  put(root, 'raw/img/x.png', PNG);
  ingestStart(root, 'raw/b.md');
  assert.equal(read(root, 'raw/b.md'), '![](assets/b/x.png)\n');
  assert.equal(fs.existsSync(path.join(root, 'raw', 'img')), false);
});
