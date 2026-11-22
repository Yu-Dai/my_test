import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatIssue, validatePage } from '../src/core/index.js';
import { codes, makeKb, makePage } from './helpers.js';

const root = makeKb();
const REL = 'wiki/topic/alpha.md';
const hasPage = (id) => ['topic/alpha', 'topic/beta'].includes(id);
const run = (text, extra = {}) => validatePage({ kbRoot: root, relPath: REL, text, hasPage, ...extra });
const body = (content) => `## 內容\n\n${content}\n\n## 相關頁面\n\n- 無\n\n## 來源\n\n- raw/spec.md#2.1\n`;

test('合格頁面：沒有任何問題，並解析出欄位', () => {
  const text = makePage({}, body('見 [[topic/beta]] 與 [[topic/beta|貝塔]]、[[other-kb:x/y]]。\n\n![一張圖](assets/pic.png)\n\n[規格](raw/spec.md) [外部](https://example.com) [錨點](#內容)'));
  const { page, issues } = run(text);
  assert.deepEqual(issues, []);
  assert.equal(page.id, 'topic/alpha');
  assert.equal(page.title, '測試頁');
  assert.deepEqual(page.keywords, ['測試', 'test']);
  assert.deepEqual(page.sources.map((s) => [s.path, s.startLine, s.endLine]), [['raw/spec.md', 9, 12], ['raw/code.c', 2, 4]]);
  assert.deepEqual(page.links.map((l) => `${l.kb ?? ''}:${l.id}`), [':topic/beta', ':topic/beta', 'other-kb:x/y']);
  assert.deepEqual(page.images.map((i) => i.path), ['assets/pic.png']);
});

test('aliases 可以是空清單', () => {
  assert.deepEqual(run(makePage({ aliases: '[]' })).issues, []);
});

test('草稿模式不要求 updated，已存模式要求', () => {
  const text = makePage({ updated: undefined });
  assert.deepEqual(run(text, { mode: 'draft' }).issues, []);
  assert.deepEqual(codes(run(text).issues), ['updated']);
  assert.deepEqual(codes(run(makePage({ updated: '2026/11/22' })).issues), ['updated']);
});

test('開頭欄位：解析失敗', () => {
  assert.deepEqual(codes(run('沒有開頭欄位\n').issues), ['frontmatter-parse']);
  assert.deepEqual(codes(run('---\ntitle: x\n').issues), ['frontmatter-parse']);
  assert.deepEqual(codes(run('---\ntitle: [未關閉\n---\n').issues), ['frontmatter-parse']);
  assert.equal(run('---\n---\n').page, null);
});

test('開頭欄位：各欄位不合格', () => {
  const one = (fm) => codes(run(makePage(fm)).issues);
  assert.deepEqual(one({ title: undefined }), ['title']);
  assert.deepEqual(one({ title: '123' }), ['title']);
  assert.deepEqual(one({ type: 'note' }), ['type']);
  assert.deepEqual(one({ type: undefined }), ['type']);
  assert.deepEqual(one({ summary: undefined }), ['summary']);
  assert.deepEqual(one({ summary: '|\n  第一行\n  第二行' }), ['summary']);
  assert.deepEqual(one({ keywords: undefined }), ['keywords']);
  assert.deepEqual(one({ keywords: '[]' }), ['keywords']);
  assert.deepEqual(one({ keywords: '單一字串' }), ['keywords']);
  assert.deepEqual(one({ aliases: undefined }), ['aliases']);
  assert.deepEqual(one({ sources: undefined }), ['sources']);
  assert.deepEqual(one({ sources: '[]' }), ['sources']);
  assert.deepEqual(one({ author: 'someone' }), ['frontmatter-unknown']);
});

test('來源引用：檔案或位置不存在', () => {
  const one = (sources) => run(makePage({ sources })).issues;
  assert.deepEqual(codes(one('\n  - raw/spec.md')), ['source-ref']);
  assert.deepEqual(codes(one('\n  - raw/nope.md#1')), ['source-ref']);
  assert.deepEqual(codes(one('\n  - raw/spec.md#9.9')), ['source-ref']);
  assert.deepEqual(codes(one('\n  - raw/code.c:L1-L999')), ['source-ref']);
  assert.deepEqual(codes(one('\n  - raw/spec.md#1\n  - spec.md#1\n  - ../raw/spec.md#1')), ['source-ref', 'source-ref']);
});

test('內文段落：缺少、多餘、順序錯、一級標題', () => {
  const one = (b) => codes(run(makePage({}, b)).issues);
  assert.deepEqual(one('## 內容\n\n文\n\n## 來源\n\n- x\n'), ['body-sections']);
  assert.deepEqual(one('## 內容\n\n## 背景\n\n## 相關頁面\n\n## 來源\n'), ['body-sections']);
  assert.deepEqual(one('## 來源\n\n## 內容\n\n## 相關頁面\n'), ['body-sections']);
  assert.deepEqual(one(`# 大標題\n\n${body('文')}`), ['body-h1']);
  // 程式碼區塊內的 # 不算標題；三級標題可自由使用
  assert.deepEqual(one(body('### 小節\n\n```sh\n# 註解\n## 也是註解\n```')), []);
});

test('連結：寫法錯誤與斷連結', () => {
  const one = (c) => codes(run(makePage({}, body(c))).issues);
  assert.deepEqual(one('[[topic/gamma]]'), ['link-broken']);
  assert.deepEqual(one('[[beta]]'), ['link-syntax']);
  assert.deepEqual(one('[[topic/beta.md]]'), ['link-syntax']);
  assert.deepEqual(one('[[Topic/Beta]]'), ['link-syntax']);
  assert.deepEqual(one('[[topic/beta|]]'), ['link-syntax']);
  assert.deepEqual(one('[貝塔](wiki/topic/beta.md)'), ['link-syntax']);
  assert.deepEqual(one('[貝塔](beta.md)'), ['link-syntax']);
  // 程式碼內的連結不檢查
  assert.deepEqual(one('`[[nope]]`\n\n```\n[[also/nope]]\n```'), []);
});

test('沒有提供 hasPage 時不檢查斷連結', () => {
  const { issues } = validatePage({ kbRoot: root, relPath: REL, text: makePage({}, body('[[topic/gamma]]')) });
  assert.deepEqual(issues, []);
});

test('路徑：相對路徑與不存在的檔案', () => {
  const one = (c) => codes(run(makePage({}, body(c))).issues);
  assert.deepEqual(one('[規格](../raw/spec.md)'), ['path']);
  assert.deepEqual(one('[規格](./raw/spec.md)'), ['path']);
  assert.deepEqual(one('[規格](spec.txt)'), ['path']);
  assert.deepEqual(one('[規格](raw/nope.md)'), ['path-missing']);
  assert.deepEqual(one('[空]()'), ['path']);
});

test('圖片：路徑、格式、說明文字', () => {
  const one = (c) => codes(run(makePage({}, body(c))).issues);
  assert.deepEqual(one('![](assets/pic.png)'), ['image-alt']);
  assert.deepEqual(one('![圖](../assets/pic.png)'), ['image-path']);
  assert.deepEqual(one('![圖](pic.png)'), ['image-path']);
  assert.deepEqual(one('![圖](https://example.com/a.png)'), ['image-path']);
  assert.deepEqual(one('![圖](assets/doc.pdf)'), ['image-path']);
  assert.deepEqual(one('![圖](assets/nope.png)'), ['path-missing']);
});

test('頁面路徑不合規則', () => {
  const { issues } = validatePage({ kbRoot: root, relPath: 'wiki/Topic/鮑率.md', text: makePage() });
  assert.deepEqual(codes(issues), ['page-path']);
});

test('內文過長只給警告', () => {
  const { issues } = run(makePage({}, body('字'.repeat(13000))));
  assert.deepEqual(codes(issues), []);
  assert.deepEqual(codes(issues, 'warn'), ['page-too-long']);
});

test('錯誤訊息固定格式：位置、正確寫法、下一步', () => {
  const [issue] = run(makePage({ type: 'note' })).issues;
  const out = formatIssue(issue);
  assert.match(out, /^\[錯誤\] wiki\/topic\/alpha\.md 第 3 行：/);
  assert.match(out, /\n {2}正確寫法：type: concept/);
  assert.match(out, /\n {2}下一步：修正後執行：kb validate wiki\/topic\/alpha\.md$/);
});
