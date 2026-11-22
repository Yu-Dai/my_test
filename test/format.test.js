import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractLinks, fenceMask, headingNumber, listHeadings, normalizeText, parseLinkTarget, parsePageId,
  parseSourceRef, pathToPageId, resolveSourceRef, validateKbJson,
} from '../src/core/index.js';
import { KB_JSON, makeKb } from './helpers.js';

test('normalizeText：全形半形與大小寫視為相同', () => {
  assert.equal(normalizeText('ＵＡＲＴ　Baud'), 'uart baud');
});

test('頁面代號：合格與不合格', () => {
  assert.deepEqual(parsePageId('uart/baud-rate'), { category: 'uart', name: 'baud-rate' });
  for (const bad of ['uart', 'uart/a/b', 'UART/x', 'uart/Baud', 'uart/baud_rate', 'uart/鮑率', 'uart/-x', 'uart/x.md', '']) {
    assert.equal(parsePageId(bad), null, bad);
  }
  assert.equal(pathToPageId('wiki/uart/baud-rate.md'), 'uart/baud-rate');
  assert.equal(pathToPageId('wiki/baud-rate.md'), null);
  assert.equal(pathToPageId('wiki/a/b/c.md'), null);
  assert.equal(pathToPageId('wiki/uart/Baud.md'), null);
});

test('連結語法：四種合法寫法', () => {
  assert.deepEqual(parseLinkTarget('uart/x'), { ok: true, kb: null, id: 'uart/x', text: null });
  assert.deepEqual(parseLinkTarget('uart/x|鮑率'), { ok: true, kb: null, id: 'uart/x', text: '鮑率' });
  assert.deepEqual(parseLinkTarget('other-kb:uart/x'), { ok: true, kb: 'other-kb', id: 'uart/x', text: null });
  assert.deepEqual(parseLinkTarget('other-kb:uart/x|文字'), { ok: true, kb: 'other-kb', id: 'uart/x', text: '文字' });
});

test('連結語法：不合法寫法', () => {
  for (const bad of ['x', 'uart/x.md', 'wiki/uart/x', '../uart/x', 'uart/x|', 'Bad_KB:uart/x', '鮑率', '']) {
    assert.equal(parseLinkTarget(bad).ok, false, bad);
  }
});

test('markdown 掃描：略過程式碼區塊與行內程式碼', () => {
  const lines = ['# 標題', '```', '# 不是標題', '[[a/b]]', '```', '`[[c/d]]` 與 [[e/f|文字]]', '![圖](assets/x.png) [連結](raw/a.md)', '~~~c', '## 也不是', '~~~', '## 二級 ##'];
  assert.deepEqual(fenceMask(lines), [false, true, true, true, true, false, false, true, true, true, false]);
  assert.deepEqual(listHeadings(lines), [{ level: 1, text: '標題', line: 1 }, { level: 2, text: '二級', line: 11 }]);
  const { wikiLinks, mdLinks } = extractLinks(lines);
  assert.deepEqual(wikiLinks, [{ inner: 'e/f|文字', line: 6 }]);
  assert.deepEqual(mdLinks, [
    { image: true, text: '圖', target: 'assets/x.png', line: 7 },
    { image: false, text: '連結', target: 'raw/a.md', line: 7 },
  ]);
});

test('來源引用寫法：合格', () => {
  assert.deepEqual(parseSourceRef('raw/spec.md#3.2'), { ok: true, path: 'raw/spec.md', kind: 'section', anchor: '3.2' });
  assert.deepEqual(parseSourceRef('raw/sub/drv.c:L120-L180'), { ok: true, path: 'raw/sub/drv.c', kind: 'lines', start: 120, end: 180 });
  assert.deepEqual(parseSourceRef('raw/drv.c:L7'), { ok: true, path: 'raw/drv.c', kind: 'lines', start: 7, end: 7 });
});

test('來源引用寫法：不合格', () => {
  for (const bad of ['raw/spec.md', 'spec.md#1', '../raw/spec.md#1', 'raw/../kb.json:L1', 'raw\\spec.md#1', 'raw/a.c:L9-L2', 'raw/a.c:L0', 'raw/a.c:10-20', '', 'raw/spec.md#']) {
    assert.equal(parseSourceRef(bad).ok, false, bad);
  }
});

test('headingNumber', () => {
  assert.equal(headingNumber('3.2 暫存器'), '3.2');
  assert.equal(headingNumber('3.2. 暫存器'), '3.2');
  assert.equal(headingNumber('４ 全形'), '4');
  assert.equal(headingNumber('3.2暫存器'), null);
  assert.equal(headingNumber('概觀'), null);
});

test('resolveSourceRef：章節編號、完整標題、不含編號的標題', () => {
  const root = makeKb();
  const byNum = resolveSourceRef(root, 'raw/spec.md#2.1');
  assert.equal(byNum.ok, true);
  assert.deepEqual([byNum.startLine, byNum.endLine, byNum.heading], [9, 12, '2.1 暫存器']);
  assert.equal(resolveSourceRef(root, 'raw/spec.md#2.1 暫存器').startLine, 9);
  assert.equal(resolveSourceRef(root, 'raw/spec.md#暫存器').startLine, 9);
  assert.equal(resolveSourceRef(root, 'raw/spec.md#附錄').startLine, 13);
  // 上層章節包含子章節，到下一個同級或更高級標題為止
  const sec2 = resolveSourceRef(root, 'raw/spec.md#2');
  assert.deepEqual([sec2.startLine, sec2.endLine], [7, 12]);
  // 最後一節到檔尾
  assert.equal(resolveSourceRef(root, 'raw/spec.md#附錄').endLine, 15);
});

test('resolveSourceRef：行數範圍', () => {
  const root = makeKb();
  const r = resolveSourceRef(root, 'raw/code.c:L2-L4');
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ['int b;', 'int c;', 'int d;']);
  assert.equal(resolveSourceRef(root, 'raw/code.c:L5').ok, true);
});

test('resolveSourceRef：失敗時給出提示', () => {
  const root = makeKb({ 'raw/bin.txt': Buffer.from([0x41, 0x00, 0x42]) });
  const missing = resolveSourceRef(root, 'raw/nope.md#1');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /找不到來源檔/);
  const noSec = resolveSourceRef(root, 'raw/spec.md#9.9');
  assert.equal(noSec.ok, false);
  assert.match(noSec.hint, /2\.1 暫存器/);
  const over = resolveSourceRef(root, 'raw/code.c:L3-L99');
  assert.match(over.reason, /只有 5 行/);
  const notMd = resolveSourceRef(root, 'raw/code.c#main');
  assert.match(notMd.reason, /只能用在 markdown/);
  assert.equal(resolveSourceRef(root, 'raw/bin.txt:L1').ok, false);
});

test('kb.json：合格', () => {
  const r = validateKbJson(JSON.stringify(KB_JSON));
  assert.deepEqual(r.issues, []);
  assert.equal(r.meta.name, 'test-kb');
});

test('kb.json：不合格案例', () => {
  const bad = (patch) => validateKbJson(JSON.stringify({ ...KB_JSON, ...patch })).issues.map((i) => i.code);
  assert.deepEqual(bad({ name: 'Test KB' }), ['kbjson-name']);
  assert.deepEqual(bad({ title: '' }), ['kbjson-title']);
  assert.deepEqual(bad({ description: undefined }), ['kbjson-description']);
  assert.deepEqual(bad({ owner: 5 }), ['kbjson-owner']);
  assert.deepEqual(bad({ category: '驅動' }), ['kbjson-category']);
  assert.deepEqual(bad({ schema_version: 99 }), ['kbjson-schema-version']);
  assert.deepEqual(bad({ schema_version: '1' }), ['kbjson-schema-version']);
  assert.deepEqual(bad({ confidentiality: undefined }), ['kbjson-confidentiality']);
  assert.deepEqual(bad({ extra: 1 }), ['kbjson-unknown']);
  assert.deepEqual(validateKbJson('{ not json').issues.map((i) => i.code), ['kbjson-parse']);
  assert.deepEqual(validateKbJson('[]').issues.map((i) => i.code), ['kbjson-parse']);
});
