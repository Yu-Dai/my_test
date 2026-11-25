import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildSearchIndex, checkKb, loadKb, readSearchIndex, renderIndex, searchWiki, staleIndexes, writeIndexes,
} from '../src/core/index.js';
import { CLI, SAMPLE_KB, codes, makeKb, makePage } from './helpers.js';

const kbCli = (root, ...args) => spawnSync(process.execPath, [CLI, ...args, '--kb', root], { encoding: 'utf8' });

test('範例知識庫：整庫檢查合格，索引是最新的', () => {
  const { kb, issues } = checkKb(SAMPLE_KB);
  assert.deepEqual(issues, []);
  assert.equal(kb.pages.size, 12);
  assert.equal(kb.meta.name, 'sample-uart');
});

test('範例知識庫：每一頁都有其他頁面連進來，每份來源都被引用', () => {
  const kb = loadKb(SAMPLE_KB);
  const linked = new Set();
  const cited = new Set();
  for (const p of kb.pages.values()) {
    for (const l of p.links) if (l.id !== p.id) linked.add(l.id);
    for (const s of p.sources) cited.add(s.path);
  }
  assert.deepEqual([...kb.pages.keys()].filter((id) => !linked.has(id)), []);
  assert.deepEqual(kb.rawFiles.filter((f) => !cited.has(f)), []);
});

test('index.md：按分類分組，每頁一行', () => {
  const root = makeKb({ 'wiki/topic/beta.md': makePage({ title: '貝塔' }), 'wiki/another/one.md': makePage({ title: '另一頁' }) });
  const md = renderIndex(loadKb(root));
  assert.match(md, /^# 測試知識庫 目錄\n/);
  assert.ok(md.indexOf('## another') < md.indexOf('## topic'));
  assert.match(md, /\n- \[\[topic\/beta\]\] 貝塔 — 一句話摘要\n/);
  assert.equal(md.split('\n').filter((l) => l.startsWith('- [[')).length, 3);
});

test('索引過期偵測與重建', () => {
  const root = makeKb();
  let kb = loadKb(root);
  assert.deepEqual(staleIndexes(kb), ['index.md', '.kb/search-index.json']);
  assert.deepEqual(codes(checkKb(root).issues), ['index-stale', 'index-stale']);
  writeIndexes(kb);
  assert.deepEqual(checkKb(root).issues, []);
  assert.equal(readSearchIndex(root).pages.length, 1);

  fs.writeFileSync(path.join(root, 'wiki', 'topic', 'alpha.md'), makePage({ summary: '改過的摘要' }));
  kb = loadKb(root);
  assert.deepEqual(staleIndexes(kb), ['index.md', '.kb/search-index.json']);
});

test('整庫檢查：斷連結、命名錯誤、raw 格式', () => {
  const root = makeKb({
    'wiki/topic/alpha.md': makePage({}, '## 內容\n\n[[topic/missing]]\n\n## 相關頁面\n\n## 來源\n'),
    'wiki/loose.md': makePage(),
    'wiki/a/b/deep.md': makePage(),
    'wiki/topic/中文.md': makePage(),
    'raw/doc.pdf': 'x',
    'raw/binary.txt': Buffer.from([1, 0, 2]),
    'raw/big5.txt': Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]),
  });
  const got = codes(checkKb(root).issues).sort();
  assert.deepEqual(got, ['link-broken', 'page-path', 'page-path', 'page-path', 'raw-binary', 'raw-encoding', 'raw-ext']);
});

test('整庫檢查：缺少 kb.json、CRLF 與 BOM 只給警告', () => {
  assert.deepEqual(codes(loadKb(makeKb({ 'kb.json': null })).issues), ['kbjson-missing']);
  const root = makeKb({ 'wiki/topic/alpha.md': `﻿${makePage().replace(/\n/g, '\r\n')}` });
  const kb = loadKb(root);
  assert.deepEqual(codes(kb.issues), []);
  assert.deepEqual(codes(kb.issues, 'warn').sort(), ['page-bom', 'page-crlf']);
  assert.equal(kb.pages.get('topic/alpha').title, '測試頁');
});

test('搜尋：標題與關鍵字命中排在內文命中之前', () => {
  const index = buildSearchIndex(loadKb(SAMPLE_KB));
  const r = searchWiki([index], ['FIFO']);
  assert.equal(r.results[0].id, 'uart/fifo-and-interrupt');
  const bodyOnly = r.results.filter((x) => x.where.length === 1 && x.where[0] === 'body');
  const tagged = r.results.filter((x) => x.where.includes('title') || x.where.includes('keywords'));
  assert.ok(tagged.length > 0 && bodyOnly.length > 0);
  assert.ok(Math.min(...tagged.map((x) => x.score)) > Math.max(...bodyOnly.map((x) => x.score)));
});

test('搜尋：別名、不分大小寫、全形半形、多關鍵字任一命中', () => {
  const index = buildSearchIndex(loadKb(SAMPLE_KB));
  const ids = (...terms) => searchWiki([index], terms, { limit: 50 }).results.map((x) => x.id);
  assert.equal(ids('波特率')[0], 'uart/baud-rate');
  assert.deepEqual(ids('ＢＲＲ'), ids('brr'));
  assert.equal(ids('8n1')[0], 'uart/frame-format');
  assert.deepEqual(ids('完全沒有這個詞'), []);
  const both = ids('pinmux', '8N1');
  assert.ok(both.includes('gpio/pin-mux') && both.includes('uart/frame-format'));
});

test('搜尋：筆數上限、總數、命中片段', () => {
  const index = buildSearchIndex(loadKb(SAMPLE_KB));
  const r = searchWiki([index], ['uart'], { limit: 3 });
  assert.equal(r.results.length, 3);
  assert.equal(r.total, 12);
  const s = searchWiki([index], ['rx_dropped']).results[0];
  assert.match(s.snippet, /rx_dropped/);
  assert.ok(s.snippet.length <= 122);
});

test('搜尋：跨多個知識庫', () => {
  const a = buildSearchIndex(loadKb(SAMPLE_KB));
  const b = buildSearchIndex(loadKb(makeKb({ 'wiki/topic/alpha.md': makePage({ title: 'FIFO 筆記' }) })));
  const kbs = new Set(searchWiki([a, b], ['fifo'], { limit: 50 }).results.map((x) => x.kb));
  assert.deepEqual([...kbs].sort(), ['sample-uart', 'test-kb']);
});

test('CLI：check、rebuild、validate、search、resolve', () => {
  const root = makeKb();
  let r = kbCli(root, 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /下一步：執行：kb rebuild/);

  r = kbCli(root, 'rebuild');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已重建/);
  assert.equal(kbCli(root, 'check').status, 0);
  assert.match(kbCli(root, 'rebuild').stdout, /沒有變更/);

  r = kbCli(root, 'validate', 'wiki/topic/alpha.md');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /結果：合格/);

  fs.writeFileSync(path.join(root, 'wiki', 'topic', 'bad.md'), makePage({ type: 'note', updated: undefined }));
  r = kbCli(root, 'validate', 'wiki/topic/bad.md', '--draft');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /type 必須是/);
  assert.doesNotMatch(r.stdout, /updated/);
  assert.equal(kbCli(root, 'rebuild').status, 1);

  r = kbCli(root, 'search', 'TEST');
  assert.match(r.stdout, /1\. topic\/alpha/);
  assert.match(kbCli(root, 'search', '沒有').stdout, /查無結果/);

  r = kbCli(root, 'search', '--grep', 'int [bd];', '--scope', 'raw', '--context', '0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\. raw\/code\.c（命中 2 行）\n {3}L2: int b;\n {3}L4: int d;/);
  assert.match(kbCli(root, 'search', '--grep', 'int c', '--scope', 'raw', '--context', '1').stdout, /L2-L4，命中 L3:\n {9}2 {2}int b;\n {3}> {5}3 {2}int c;\n {9}4 {2}int d;/);
  assert.match(kbCli(root, 'search', '--grep', '一句話.{2}', '--context', '0').stdout, /1\. wiki\/topic\/alpha\.md（命中 1 行）\n {3}L4: summary: 一句話摘要/);
  assert.match(kbCli(root, 'search', '--grep', '一句話.{2}').stdout, /L1-L\d+，命中 L4:[\s\S]*已附上命中行前後各 20 行/);
  assert.match(kbCli(root, 'search', '--grep', 'int b(').stdout, /查無結果[\s\S]*--scope raw/);
  assert.match(kbCli(root, 'search', '--grep', 'int b(', '--scope', 'raw').stdout, /已當成一般文字比對/);
  assert.equal(kbCli(root, 'search', '--grep', 'x', 'extra').status, 2);
  assert.equal(kbCli(root, 'search', 'x', '--scope', 'raw').status, 2);
  assert.equal(kbCli(root, 'search', '--grep', 'x', '--scope', 'all').status, 2);

  r = kbCli(root, 'resolve', 'raw/code.c:L2-L3');
  assert.match(r.stdout, /第 2-3 行/);
  r = kbCli(root, 'resolve', 'raw/spec.md#9');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /可用的章節/);
});

test('CLI：找不到知識庫與未知指令', () => {
  const r = spawnSync(process.execPath, [CLI, 'check', '--kb', path.join(SAMPLE_KB, 'nope')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /找不到知識庫/);
  assert.equal(kbCli(SAMPLE_KB, 'frobnicate').status, 2);
});
