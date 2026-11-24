import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LIMITS } from '../src/core/index.js';
import { loadConfig } from '../src/mcp/config.js';
import { Mounts } from '../src/mcp/mounts.js';
import { fetchImage, fetchRaw, getWikiInfo, normalizePageRef, readWiki, searchWikiTool } from '../src/mcp/tools.js';
import { KB_JSON, REPO_ROOT, SAMPLE_KB, makeKb, makePage } from './helpers.js';

const SERVER = path.join(REPO_ROOT, 'src', 'mcp', 'server.js');
const sample = () => new Mounts([SAMPLE_KB]);
const otherKb = (files = {}) => makeKb({ 'kb.json': JSON.stringify({ ...KB_JSON, name: 'other', category: 'notes' }), ...files });

// ------------------------------------------------------------------ 設定與掛載

test('設定檔：讀取路徑、相對路徑以設定檔位置為準', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-cfg-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ knowledge_bases: [{ path: 'kb-a' }, 'kb-b', { nope: 1 }] }));
  const r = loadConfig(['--config', cfg], {});
  assert.deepEqual(r.paths, [path.join(dir, 'kb-a'), path.join(dir, 'kb-b')]);
  assert.equal(r.problems.length, 1);
  assert.deepEqual(loadConfig([], { LLM_WIKI_CONFIG: cfg }).paths, r.paths);
});

test('設定檔：不存在、壞掉、--kb 直接指定', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-cfg-'));
  assert.match(loadConfig(['--config', path.join(dir, 'nope.json')], {}).problems[0], /找不到設定檔/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.match(loadConfig(['--config', path.join(dir, 'bad.json')], {}).problems[0], /不是合法的 JSON/);
  fs.writeFileSync(path.join(dir, 'empty.json'), '{}');
  assert.match(loadConfig(['--config', path.join(dir, 'empty.json')], {}).problems[0], /缺少 knowledge_bases/);
  const direct = loadConfig(['--kb', SAMPLE_KB, '--config', path.join(dir, 'empty.json')], {});
  assert.deepEqual(direct.paths, [SAMPLE_KB]);
});

test('掛載檢查：路徑錯誤、kb.json 不合格、代號重複、版本不支援', () => {
  const dup = makeKb({ 'kb.json': JSON.stringify({ ...KB_JSON, name: 'sample-uart' }) });
  const badVer = makeKb({ 'kb.json': JSON.stringify({ ...KB_JSON, schema_version: 99 }) });
  const m = new Mounts([SAMPLE_KB, dup, badVer, path.join(SAMPLE_KB, 'nope')]);
  assert.deepEqual(m.names(), ['sample-uart']);
  assert.equal(m.problems.length, 3);
  assert.match(m.problems[0], /代號「sample-uart」.*重複/);
  assert.match(m.problems[1], /schema_version 不支援/);
  assert.match(m.problems[2], /找不到 kb\.json/);
  assert.match(getWikiInfo(m), /以下知識庫沒有掛載成功/);
});

test('沒有掛載任何知識庫時，每個工具都說明怎麼處理', () => {
  const m = new Mounts([], ['找不到設定檔 X']);
  for (const out of [getWikiInfo(m), searchWikiTool(m, { terms: ['a'] }), readWiki(m, { pages: ['a/b'] }), fetchRaw(m, { path: 'raw/a.md' })]) {
    assert.match(out, /目前沒有掛載任何知識庫/);
    assert.match(out, /找不到設定檔 X/);
    assert.match(out, /knowledge_bases/);
  }
});

test('知識庫內容變動後自動重新載入', () => {
  const root = makeKb();
  const m = new Mounts([root]);
  assert.match(getWikiInfo(m), /1 頁/);
  fs.writeFileSync(path.join(root, 'wiki', 'topic', 'beta.md'), makePage({ title: '新頁面' }));
  fs.writeFileSync(path.join(root, 'index.md'), `changed ${Date.now()}`);
  fs.utimesSync(path.join(root, 'index.md'), new Date(), new Date(Date.now() + 5000));
  assert.match(getWikiInfo(m), /2 頁/);
  assert.match(readWiki(m, { pages: ['topic/beta'] }), /標題：新頁面/);
});

// ------------------------------------------------------------------ GetWikiInfo

test('GetWikiInfo：不帶參數列出名片，可用分類過濾', () => {
  const m = new Mounts([SAMPLE_KB, otherKb()]);
  const out = getWikiInfo(m);
  assert.match(out, /已掛載 2 個知識庫/);
  assert.match(out, /代號 sample-uart｜DB1 UART 範例知識庫｜分類 driver｜12 頁/);
  assert.match(out, /代號 other｜/);
  assert.match(out, /下一步：/);
  const filtered = getWikiInfo(m, { category: 'notes' });
  assert.match(filtered, /已掛載 1 個知識庫（分類 notes）/);
  assert.doesNotMatch(filtered, /sample-uart｜/);
  assert.match(getWikiInfo(m, { category: 'zzz' }), /現有的知識庫分類：driver、notes/);
});

test('GetWikiInfo：帶 kb 列出目錄；代號錯誤時列出可用代號', () => {
  const m = sample();
  const out = getWikiInfo(m, { kb: 'sample-uart' });
  assert.match(out, /分類 uart（8 頁）：/);
  assert.match(out, /- uart\/baud-rate｜鮑率計算｜/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 12);
  assert.match(getWikiInfo(m, { kb: 'nope' }), /可用的知識庫代號：sample-uart/);
  const cat = getWikiInfo(m, { kb: 'sample-uart', category: 'guide' });
  assert.equal(cat.split('\n').filter((l) => l.startsWith('- ')).length, 3);
  assert.match(getWikiInfo(m, { kb: 'sample-uart', category: 'zzz' }), /現有分類：gpio、guide、uart/);
});

test('GetWikiInfo：頁數超過門檻先回分類大綱，分類內可翻頁', () => {
  const files = {};
  const n = LIMITS.indexMaxLines + 5;
  for (let i = 0; i < n; i++) files[`wiki/big/p${String(i).padStart(4, '0')}.md`] = makePage({ title: `頁面 ${i}` });
  const m = new Mounts([makeKb(files)]);
  const outline = getWikiInfo(m, { kb: 'test-kb' });
  assert.match(outline, /先列出分類大綱/);
  assert.match(outline, new RegExp(`- big（${n} 頁）`));
  assert.doesNotMatch(outline, /big\/p0000/);
  const page1 = getWikiInfo(m, { kb: 'test-kb', category: 'big' });
  assert.equal(page1.split('\n').filter((l) => l.startsWith('- big/')).length, LIMITS.indexMaxLines);
  assert.match(page1, new RegExp(`還有 5 頁沒列出：再呼叫一次並加上 offset=${LIMITS.indexMaxLines}`));
  const page2 = getWikiInfo(m, { kb: 'test-kb', category: 'big', offset: String(LIMITS.indexMaxLines) });
  assert.equal(page2.split('\n').filter((l) => l.startsWith('- big/')).length, 5);
});

// ------------------------------------------------------------------- SearchWiki

test('SearchWiki：回傳代號、摘要、片段與下一步；terms 可給字串', () => {
  const m = sample();
  const out = searchWikiTool(m, { terms: ['波特率'] });
  assert.match(out, /1\. 知識庫 sample-uart｜頁面 uart\/baud-rate｜鮑率計算/);
  assert.match(out, /下一步：ReadWiki\(kb="sample-uart", pages=\["uart\/baud-rate"\]\)/);
  assert.match(searchWikiTool(m, { terms: 'ＦＩＦＯ' }), /1\. 知識庫 sample-uart｜頁面 uart\/fifo-and-interrupt/);
});

test('SearchWiki：筆數上限與 offset', () => {
  const m = sample();
  const out = searchWikiTool(m, { terms: ['uart'], limit: 5 });
  assert.match(out, /共 12 筆，顯示第 1-5 筆/);
  assert.match(out, /還有 7 筆：再呼叫一次並加上 offset=5/);
  const next = searchWikiTool(m, { terms: ['uart'], limit: 5, offset: 10 });
  assert.match(next, /顯示第 11-12 筆/);
  assert.doesNotMatch(next, /還有/);
  assert.match(searchWikiTool(m, { terms: ['uart'], limit: 999 }), /顯示第 1-12 筆/);
});

test('SearchWiki：查無結果與參數錯誤都給下一步', () => {
  const m = sample();
  const none = searchWikiTool(m, { terms: ['量子糾纏'], kb: 'sample-uart' });
  assert.match(none, /查無結果/);
  assert.match(none, /scope="raw"/);
  assert.match(none, /不指定 kb/);
  assert.match(searchWikiTool(m, {}), /缺少 terms/);
  assert.match(searchWikiTool(m, { terms: [] }), /缺少 terms/);
  assert.match(searchWikiTool(m, { terms: ['a'], scope: 'all' }), /scope 只能是/);
  assert.match(searchWikiTool(m, { terms: ['a'], kb: 'nope' }), /可用的知識庫代號/);
});

test('SearchWiki：scope=raw 搜尋原始檔並指向 FetchRaw', () => {
  const m = sample();
  const out = searchWikiTool(m, { terms: ['rx_dropped'], scope: 'raw' });
  assert.match(out, /1\. 知識庫 sample-uart｜raw\/uart_drv\.c（命中 3 行）/);
  assert.match(out, /L29: static volatile uint32_t rx_dropped;/);
  assert.match(out, /下一步：FetchRaw\(kb="sample-uart", path="raw\/uart_drv\.c", start_line=19, end_line=59\)/);
  // 只在 raw 出現、頁面沒寫到的詞
  assert.match(searchWikiTool(m, { terms: ['irq_enable'] }), /查無結果/);
  assert.match(searchWikiTool(m, { terms: ['irq_enable'], scope: 'raw' }), /raw\/uart_drv\.c/);
});

test('SearchWiki：不指定 kb 時跨知識庫', () => {
  const m = new Mounts([SAMPLE_KB, otherKb({ 'wiki/topic/alpha.md': makePage({ title: 'FIFO 筆記' }) })]);
  const out = searchWikiTool(m, { terms: ['fifo'], limit: 30 });
  assert.match(out, /知識庫 other｜頁面 topic\/alpha/);
  assert.match(out, /知識庫 sample-uart｜頁面 uart\/fifo-and-interrupt/);
  assert.doesNotMatch(searchWikiTool(m, { terms: ['fifo'], kb: 'other' }), /sample-uart｜頁面/);
});

// --------------------------------------------------------------------- ReadWiki

test('頁面代號的寬鬆寫法', () => {
  assert.deepEqual(normalizePageRef('uart/baud-rate'), { kb: null, id: 'uart/baud-rate' });
  assert.deepEqual(normalizePageRef('[[uart/baud-rate|鮑率]]'), { kb: null, id: 'uart/baud-rate' });
  assert.deepEqual(normalizePageRef('sample-uart:uart/baud-rate'), { kb: 'sample-uart', id: 'uart/baud-rate' });
  assert.deepEqual(normalizePageRef('wiki/uart/Baud-Rate.md'), { kb: null, id: 'uart/baud-rate' });
  assert.deepEqual(normalizePageRef('wiki\\uart\\baud-rate.md'), { kb: null, id: 'uart/baud-rate' });
});

test('ReadWiki：內容、連到的頁面、來源清單、圖片改寫成 kb://', () => {
  const m = sample();
  const out = readWiki(m, { kb: 'sample-uart', pages: ['uart/frame-format'] });
  assert.match(out, /===== 知識庫 sample-uart｜頁面 uart\/frame-format =====/);
  assert.match(out, /標題：UART 訊框格式/);
  assert.match(out, /\]\(kb:\/\/sample-uart\/assets\/uart-spec-001\.png\)/);
  assert.doesNotMatch(out, /\]\(assets\//);
  assert.match(out, /--- 本頁連到的頁面.*\n- uart\/status-register｜狀態暫存器 SR｜/);
  assert.match(out, /--- 本頁的來源.*\n- raw\/uart-spec\.md#訊框格式/);
});

test('ReadWiki：多頁、省略 kb、各種代號寫法', () => {
  const m = sample();
  const out = readWiki(m, { pages: ['[[uart/baud-rate]]', 'wiki/guide/init-uart.md', 'sample-uart:gpio/pin-mux'] });
  assert.equal(out.match(/^===== /gm).length, 3);
  assert.equal(readWiki(m, { pages: 'uart/baud-rate' }).match(/^===== /gm).length, 1);
});

test('ReadWiki：找不到頁面時給相近的頁面', () => {
  const m = sample();
  const out = readWiki(m, { pages: ['uart/baud', 'uart/controller'] });
  assert.match(out, /===== 知識庫 sample-uart｜頁面 uart\/controller/);
  assert.match(out, /沒有頁面「uart\/baud」。相近的頁面：\n- uart\/baud-rate｜/);
  assert.match(readWiki(m, { pages: ['鮑率'] }), /不是合法的頁面代號/);
  assert.match(readWiki(m, {}), /缺少 pages/);
  assert.match(readWiki(m, { kb: 'nope', pages: ['a/b'] }), /可用的知識庫代號/);
  const two = new Mounts([SAMPLE_KB, otherKb()]);
  assert.match(readWiki(two, { pages: ['a/b'] }), /需要指定 kb/);
});

test('ReadWiki：超過輸出上限時列出尚未回傳的頁面', () => {
  const body = `## 內容\n\n${'字'.repeat(11000)}\n\n## 相關頁面\n\n## 來源\n`;
  const files = {};
  for (const n of ['a', 'b', 'c', 'd']) files[`wiki/big/${n}.md`] = makePage({}, body);
  const m = new Mounts([makeKb(files)]);
  const out = readWiki(m, { pages: ['big/a', 'big/b', 'big/c', 'big/d'] });
  assert.equal(out.match(/^===== /gm).length, 2);
  assert.match(out, /請再呼叫一次 ---\nReadWiki\(kb="test-kb", pages=\["big\/c", "big\/d"\]\)/);
  assert.ok(out.length < LIMITS.readMaxChars + 500);
});

test('ReadWiki：跨知識庫連結', () => {
  const body = '## 內容\n\n[[sample-uart:uart/baud-rate]] [[missing-kb:x/y]]\n\n## 相關頁面\n\n## 來源\n';
  const m = new Mounts([SAMPLE_KB, otherKb({ 'wiki/topic/alpha.md': makePage({}, body) })]);
  const out = readWiki(m, { kb: 'other', pages: ['topic/alpha'] });
  assert.match(out, /- sample-uart:uart\/baud-rate｜鮑率計算｜/);
  assert.match(out, /- missing-kb:x\/y（知識庫 missing-kb 沒有掛載）/);
});

// --------------------------------------------------------------------- FetchRaw

test('FetchRaw：來源引用寫法、section 參數、行數參數', () => {
  const m = sample();
  const bySec = fetchRaw(m, { kb: 'sample-uart', path: 'raw/uart-spec.md#3.2' });
  assert.match(bySec, /raw\/uart-spec\.md 第 37-46 行（章節：3\.2 鮑率暫存器 BRR）｜全檔共 82 行/);
  assert.match(bySec, / {3}42 {2}baud = PCLK/);
  assert.equal(fetchRaw(m, { path: 'raw/uart-spec.md', section: '3.2' }), bySec);
  assert.equal(fetchRaw(m, { path: 'uart-spec.md', section: '#3.2' }), bySec);

  const byRef = fetchRaw(m, { path: 'raw/uart_drv.c:L31-L33' });
  assert.match(byRef, /第 31-33 行｜全檔共 144 行/);
  assert.equal(fetchRaw(m, { path: 'raw/uart_drv.c', start_line: 31, end_line: '33' }), byRef);
  assert.equal(fetchRaw(m, { path: 'raw\\uart_drv.c', start_line: 31, end_line: 33 }), byRef);
  // 結束行超過檔尾時自動收到檔尾
  assert.match(fetchRaw(m, { path: 'raw/uart_drv.c', start_line: 140, end_line: 999 }), /第 140-144 行/);
});

test('FetchRaw：只給檔名時，小檔回全文', () => {
  const out = fetchRaw(sample(), { path: 'raw/error-codes.csv' });
  assert.match(out, /第 1-6 行｜全檔共 6 行/);
  assert.match(out, /UART_E_FRAME/);
});

test('FetchRaw：大檔回章節大綱，讀取時截斷並給續讀指令', () => {
  const lines = ['# 大文件', ''];
  for (let s = 1; s <= 4; s++) {
    lines.push(`## ${s} 第 ${s} 章`, '');
    for (let i = 0; i < 200; i++) lines.push(`第 ${s} 章的第 ${i} 行`);
  }
  const m = new Mounts([makeKb({ 'raw/big.md': lines.join('\n') })]);
  const outline = fetchRaw(m, { path: 'raw/big.md' });
  assert.match(outline, /內容較長，先列出章節/);
  assert.match(outline, / {2}- 2 第 2 章（第 205 行）/);
  assert.match(outline, /section="章節編號或標題"/);

  const cut = fetchRaw(m, { path: 'raw/big.md', start_line: 1, end_line: 700 });
  assert.match(cut, new RegExp(`第 1-${LIMITS.rawMaxLines} 行`));
  assert.match(cut, new RegExp(`繼續讀取：FetchRaw\\(kb="test-kb", path="raw/big.md", start_line=${LIMITS.rawMaxLines + 1}, end_line=700\\)`));
  assert.equal(cut.split('\n').filter((l) => /^ *\d+ {2}/.test(l)).length, LIMITS.rawMaxLines);
});

test('FetchRaw：錯誤情況都給下一步，且不能讀 raw/ 以外的檔案', () => {
  const m = sample();
  assert.match(fetchRaw(m, {}), /缺少 path/);
  assert.match(fetchRaw(m, { path: 'raw/uart_drv.cpp' }), /相近的檔案：.*raw\/uart_drv\.c/);
  assert.match(fetchRaw(m, { path: 'raw/zzz.md' }), /可用的來源檔：raw\/error-codes\.csv/);
  assert.match(fetchRaw(m, { path: 'raw/uart-spec.md#9.9' }), /找不到章節「9\.9」[\s\S]*可用的章節/);
  assert.match(fetchRaw(m, { path: 'raw/uart_drv.c', section: 'main' }), /只能用在 markdown/);
  assert.match(fetchRaw(m, { path: 'raw/uart_drv.c', start_line: 500 }), /超出範圍.*全檔共 144 行/);
  for (const p of ['kb.json', '../kb.json', 'raw/../kb.json', 'wiki/uart/baud-rate.md', 'C:/Windows/win.ini', '/etc/passwd']) {
    const out = fetchRaw(m, { path: p });
    assert.match(out, /沒有來源檔/, p);
    assert.doesNotMatch(out, /sample-uart"|schema_version/, p);
  }
});

test('FetchImage：路徑寫法、找不到、超過上限、SVG', () => {
  const big = Buffer.alloc(LIMITS.imageMaxBytes + 1);
  const root = makeKb({ 'assets/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'assets/sub/big.png': big, 'assets/notes.txt': 'x' });
  const m = new Mounts([{ path: root }, { path: SAMPLE_KB }]);
  const png = 'assets/uart-spec-001.png';
  // 幾種寫法都指到同一張圖
  for (const args of [{ path: `kb://sample-uart/${png}` }, { kb: 'sample-uart', path: png }, { kb: 'sample-uart', path: 'uart-spec-001.png' }, { kb: 'sample-uart', path: `/${png.split('/').join('\\')}` }]) {
    const r = fetchImage(m, args);
    assert.equal(r.image.mimeType, 'image/png', JSON.stringify(args));
    assert.match(r.text, /知識庫 sample-uart｜assets\/uart-spec-001\.png[\s\S]*看不到圖片/);
  }
  assert.match(fetchImage(m, { path: png }), /需要指定 kb/);
  assert.match(fetchImage(m, { path: 'kb://nope/assets/x.png' }), /沒有「nope」這個知識庫/);
  assert.match(fetchImage(m, { kb: 'sample-uart' }), /缺少 path[\s\S]*FetchImage\(kb="sample-uart", path="assets\/uart-spec-001\.png"\)/);
  assert.match(fetchImage(m, { kb: 'sample-uart', path: 'assets/nope.png' }), /沒有圖片「assets\/nope\.png」。可用的圖片：assets\/uart-spec-001\.png/);
  // 只能讀 assets/ 裡的圖片：跳出資料夾、讀其他檔案都擋下
  for (const bad of ['../kb.json', 'assets/../kb.json', 'raw/spec.md', 'assets/notes.txt', 'kb://test-kb/kb.json']) {
    assert.match(fetchImage(m, { kb: 'test-kb', path: bad }), /沒有圖片/, bad);
  }
  assert.match(fetchImage(m, { kb: 'test-kb', path: 'assets/sub/big.png' }), /超過可回傳的上限 1024 KB[\s\S]*依上面的說明文字回答/);
  assert.match(fetchImage(m, { kb: 'test-kb', path: 'assets/diagram.svg' }), /SVG 向量圖[\s\S]*<svg xmlns/);
  assert.match(fetchImage(new Mounts([]), { path: png }), /目前沒有掛載任何知識庫/);
});

test('ReadWiki：有圖片的頁面列出圖片路徑，沒有的不列', () => {
  const m = new Mounts([{ path: SAMPLE_KB }]);
  assert.match(readWiki(m, { pages: ['uart/frame-format'] }), /--- 本頁的圖片（需要看圖時用 FetchImage 讀取[^\n]*\n- kb:\/\/sample-uart\/assets\/uart-spec-001\.png｜UART 訊框時序圖/);
  assert.doesNotMatch(readWiki(m, { pages: ['uart/baud-rate'] }), /本頁的圖片/);
});

// ------------------------------------------------------------------ stdio 端到端

test('端到端：MCP client 透過 stdio 走完 查索引 → 搜尋 → 讀頁 → 讀 raw', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, '--kb', SAMPLE_KB], stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions(), /GetWikiInfo/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['FetchImage', 'FetchRaw', 'GetWikiInfo', 'ReadWiki', 'SearchWiki']);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.ok(t.description.length > 20);
    }
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.notEqual(r.isError, true);
      return r.content[0].text;
    };
    assert.match(await call('GetWikiInfo', {}), /代號 sample-uart/);
    assert.match(await call('SearchWiki', { terms: ['115200'] }), /頁面 uart\/baud-rate/);
    assert.match(await call('SearchWiki', { terms: 'brr' }), /頁面 uart\/baud-rate-register/);
    const page = await call('ReadWiki', { kb: 'sample-uart', pages: ['uart/baud-rate'] });
    assert.match(page, /- raw\/uart_drv\.c:L31-L46/);
    assert.match(await call('FetchRaw', { kb: 'sample-uart', path: 'raw/uart_drv.c:L31-L46' }), /int uart_set_baud\(uint32_t baud\)/);
    assert.match(await call('FetchRaw', { path: 'raw/uart_drv.c', start_line: '31', end_line: 32 }), /第 31-32 行/);
    // 讀頁 → 從「本頁的圖片」拿路徑 → 讀圖，圖片以 image 內容回傳
    const withImage = await call('ReadWiki', { pages: ['uart/frame-format'] });
    const imagePath = withImage.match(/本頁的圖片[^\n]*\n- (kb:\/\/\S+?)｜/)[1];
    assert.equal(imagePath, 'kb://sample-uart/assets/uart-spec-001.png');
    const img = await client.callTool({ name: 'FetchImage', arguments: { path: imagePath } });
    assert.notEqual(img.isError, true);
    assert.deepEqual(img.content.map((c) => c.type), ['text', 'image']);
    assert.match(img.content[0].text, /頁面對這張圖的說明：UART 訊框時序圖/);
    assert.equal(img.content[1].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(img.content[1].data, 'base64'), fs.readFileSync(path.join(SAMPLE_KB, 'assets', 'uart-spec-001.png')));
  } finally {
    await client.close();
  }
});

test('端到端：設定檔不存在時 server 仍啟動，工具回報怎麼修', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, '--config', path.join(os.tmpdir(), 'llm-wiki-nope.json')], stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: 'GetWikiInfo', arguments: {} });
    assert.match(r.content[0].text, /目前沒有掛載任何知識庫[\s\S]*找不到設定檔/);
  } finally {
    await client.close();
  }
});
