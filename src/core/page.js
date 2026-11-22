// 頁面解析與驗證。每個問題都帶「哪裡不合格、正確寫法、下一步」。

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BODY_SECTIONS, FRONTMATTER_FIELDS, IMAGE_EXTENSIONS, LIMITS, PAGE_TYPES } from './constants.js';
import { parseLinkTarget, pathToPageId } from './ids.js';
import { extractLinks, listHeadings } from './markdown.js';
import { SOURCE_REF_EXAMPLES, resolveSourceRef } from './sourceref.js';
import { splitLines } from './text.js';

const FRONTMATTER_EXAMPLE = [
  '---',
  'title: UART 驅動程式',
  'type: summary',
  'summary: 一句話摘要',
  'keywords: [UART, 串列埠]',
  'aliases: [serial]',
  'sources:',
  '  - raw/spec.md#3.2',
  '---',
].join('\n');

/**
 * 拆出開頭欄位與內文。
 * @returns {{ ok: true, data: object, fmLines: string[], bodyLines: string[], bodyStartLine: number } | { ok: false, line: number, reason: string }}
 */
export function parsePage(text) {
  const lines = splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (lines[0].trimEnd() !== '---') {
    return { ok: false, line: 1, reason: '第一行必須是 ---（開頭欄位的起始）' };
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (close === -1) return { ok: false, line: 1, reason: '開頭欄位沒有用 --- 結束' };
  const fmLines = lines.slice(1, close);
  let data;
  try {
    data = YAML.parse(fmLines.join('\n'));
  } catch (e) {
    const l = e.linePos?.[0]?.line;
    return { ok: false, line: l ? l + 1 : 1, reason: `開頭欄位不是合法的 YAML：${String(e.message).split('\n')[0]}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, line: 1, reason: '開頭欄位是空的或格式不對' };
  }
  return { ok: true, data, fmLines, bodyLines: lines.slice(close + 1), bodyStartLine: close + 2 };
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 驗證單一頁面。
 * @param {object} ctx
 * @param {string} ctx.kbRoot 知識庫根目錄
 * @param {string} ctx.relPath 頁面相對路徑，例如 wiki/uart/overview.md
 * @param {string} ctx.text 檔案內容
 * @param {'draft'|'stored'} [ctx.mode] draft：LLM 剛寫好、尚未由腳本填 updated；stored：已在知識庫內
 * @param {(id: string) => boolean} [ctx.hasPage] 判斷同庫頁面是否存在；省略則不檢查斷連結
 * @returns {{ page: object|null, issues: object[] }}
 */
export function validatePage({ kbRoot, relPath, text, mode = 'stored', hasPage }) {
  const issues = [];
  const next = `修正後執行：kb validate ${relPath}`;
  const add = (level, code, line, message, example) => issues.push({ level, code, file: relPath, line, message, example, next });
  const err = (code, line, message, example) => add('error', code, line, message, example);

  const id = pathToPageId(relPath);
  if (!id) {
    err('page-path', null, '頁面路徑不合規則', 'wiki/<分類>/<名稱>.md，分類與名稱都用小寫英數加連字號，例如 wiki/uart/baud-rate.md（中文放在 title）');
  }

  const parsed = parsePage(text);
  if (!parsed.ok) {
    err('frontmatter-parse', parsed.line, parsed.reason, FRONTMATTER_EXAMPLE);
    return { page: null, issues };
  }
  const { data, fmLines, bodyLines, bodyStartLine } = parsed;
  const lineOf = (key) => {
    const i = fmLines.findIndex((l) => l.startsWith(`${key}:`));
    return i === -1 ? 1 : i + 2;
  };

  // ---- 開頭欄位 ----
  for (const key of Object.keys(data)) {
    if (!FRONTMATTER_FIELDS.includes(key)) {
      err('frontmatter-unknown', lineOf(key), `未知的欄位「${key}」`, `只能有這些欄位：${FRONTMATTER_FIELDS.join('、')}`);
    }
  }
  if (!isStr(data.title)) err('title', lineOf('title'), '缺少 title，或 title 不是文字', 'title: UART 鮑率設定');
  if (!PAGE_TYPES.includes(data.type)) {
    err('type', lineOf('type'), `type 必須是 ${PAGE_TYPES.join('、')} 其中之一${data.type === undefined ? '' : `，目前是「${data.type}」`}`, 'type: concept');
  }
  if (!isStr(data.summary)) err('summary', lineOf('summary'), '缺少 summary，或 summary 不是文字', 'summary: 說明 UART 鮑率的計算方式與常見設定值');
  else if (/\n/.test(data.summary.trim())) err('summary', lineOf('summary'), 'summary 只能有一行', 'summary: 說明 UART 鮑率的計算方式與常見設定值');

  if (!Array.isArray(data.keywords) || data.keywords.length === 0 || !data.keywords.every((k) => isStr(k) || typeof k === 'number')) {
    err('keywords', lineOf('keywords'), 'keywords 必須是至少一個關鍵字的清單（中英文與縮寫都寫進去）', 'keywords: [鮑率, baud rate, BRR]');
  }
  if (!Array.isArray(data.aliases) || !data.aliases.every((k) => isStr(k) || typeof k === 'number')) {
    err('aliases', lineOf('aliases'), 'aliases 必須是清單（沒有別名就寫空清單）', 'aliases: [波特率, baudrate] 或 aliases: []');
  }

  const sources = [];
  if (!Array.isArray(data.sources) || data.sources.length === 0) {
    err('sources', lineOf('sources'), 'sources 必須是至少一筆來源引用的清單', `sources:\n  - raw/spec.md#3.2\n（寫法：${SOURCE_REF_EXAMPLES}）`);
  } else {
    for (const ref of data.sources) {
      const r = typeof ref === 'string' ? resolveSourceRef(kbRoot, ref) : { ok: false, reason: '來源引用必須是文字' };
      if (r.ok) sources.push({ ref: String(ref).trim(), path: r.path, startLine: r.startLine, endLine: r.endLine });
      else err('source-ref', lineOf('sources'), `來源引用「${ref}」無效：${r.reason}`, r.hint ?? SOURCE_REF_EXAMPLES);
    }
  }

  if (mode === 'stored' && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.updated ?? ''))) {
    err('updated', lineOf('updated'), 'updated 缺少或格式不對（此欄位由腳本寫入）', 'updated: 2026-11-22');
  }

  // ---- 內文段落 ----
  const headings = listHeadings(bodyLines, bodyStartLine);
  for (const h of headings.filter((x) => x.level === 1)) {
    err('body-h1', h.line, '內文不要用一級標題（# ），頁面標題寫在 title 欄位', '小節請用 ### 寫在「## 內容」底下');
  }
  const h2 = headings.filter((x) => x.level === 2);
  const sectionExample = BODY_SECTIONS.map((s) => `## ${s}`).join('\n...\n');
  if (h2.map((x) => x.text).join('|') !== BODY_SECTIONS.join('|')) {
    const extra = h2.find((x) => !BODY_SECTIONS.includes(x.text));
    const missing = BODY_SECTIONS.filter((s) => !h2.some((x) => x.text === s));
    const why = missing.length ? `缺少段落「${missing.join('、')}」` : extra ? `多了二級標題「${extra.text}」（小節請改用 ###）` : '段落順序不對';
    err('body-sections', extra?.line ?? bodyStartLine, `內文必須剛好有三個二級標題，依序是 ${BODY_SECTIONS.join('、')}：${why}`, sectionExample);
  }

  // ---- 連結與圖片 ----
  const { wikiLinks, mdLinks } = extractLinks(bodyLines, bodyStartLine);
  const links = [];
  for (const w of wikiLinks) {
    const t = parseLinkTarget(w.inner);
    if (!t.ok) {
      err('link-syntax', w.line, `連結 [[${w.inner}]] 寫法不對：${t.reason}`, '[[uart/baud-rate]] 或 [[uart/baud-rate|鮑率]] 或 [[other-kb:uart/baud-rate]]');
      continue;
    }
    links.push({ kb: t.kb, id: t.id, line: w.line });
    if (!t.kb && hasPage && !hasPage(t.id)) {
      err('link-broken', w.line, `連結 [[${t.id}]] 指到不存在的頁面`, '確認頁面代號（分類/名稱）是否正確，或先建立該頁');
    }
  }

  const images = [];
  for (const m of mdLinks) {
    const what = m.image ? '圖片' : '連結';
    if (!m.target) {
      err('path', m.line, `${what}的路徑是空的`, m.image ? '![說明文字](assets/xxx.png)' : '[文字](raw/spec.md)');
      continue;
    }
    const external = /^(https?:|mailto:)/i.test(m.target);
    if (!m.image && (external || m.target.startsWith('#'))) continue;
    const target = m.target.split('#')[0];
    const badSeg = target.split('/').some((s) => s === '..' || s === '.' || s === '');
    if (m.image) {
      if (external || !target.startsWith('assets/') || badSeg || target.includes('\\')) {
        err('image-path', m.line, `圖片路徑「${m.target}」不合規則：圖片必須放在 assets/，路徑從知識庫根目錄寫起`, '![UART 訊框時序圖](assets/uart-frame.png)');
        continue;
      }
      if (!IMAGE_EXTENSIONS.includes(path.extname(target).toLowerCase())) {
        err('image-path', m.line, `「${m.target}」不是支援的圖片格式（${IMAGE_EXTENSIONS.join(' ')}）`, '![UART 訊框時序圖](assets/uart-frame.png)');
        continue;
      }
      if (!m.text) err('image-alt', m.line, `圖片 ${m.target} 沒有說明文字`, `![這張圖在說明什麼](${m.target})`);
      images.push({ path: target, alt: m.text, line: m.line });
    } else {
      const pointsToRaw = /(^|\/)raw\//.test(target);
      if (/(^|\/)wiki\//.test(target) || (target.endsWith('.md') && !pointsToRaw)) {
        err('link-syntax', m.line, `連到其他頁面不要用 markdown 連結「${m.target}」`, '改用 [[分類/名稱]] 或 [[分類/名稱|顯示文字]]');
        continue;
      }
      if (!(target.startsWith('raw/') || target.startsWith('assets/')) || badSeg || target.includes('\\')) {
        err('path', m.line, `路徑「${m.target}」不合規則：一律從知識庫根目錄寫起，不用相對路徑`, '[規格書](raw/spec.md) 或 ![說明](assets/xxx.png)');
        continue;
      }
    }
    const abs = path.join(kbRoot, ...target.split('/'));
    if (!fs.existsSync(abs)) err('path-missing', m.line, `找不到檔案 ${target}`, '確認檔名與大小寫；圖片放 assets/，來源放 raw/');
  }

  const bodyChars = bodyLines.join('\n').length;
  if (bodyChars > LIMITS.pageMaxChars) {
    add('warn', 'page-too-long', bodyStartLine, `內文 ${bodyChars} 字，超過上限 ${LIMITS.pageMaxChars}`, '把內容拆成多頁，用 [[分類/名稱]] 互相連結');
  }

  const page = {
    id,
    path: relPath,
    title: isStr(data.title) ? data.title.trim() : '',
    type: data.type,
    summary: isStr(data.summary) ? data.summary.trim() : '',
    keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
    aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
    updated: data.updated === undefined ? null : String(data.updated),
    sources,
    links,
    images,
    body: bodyLines.join('\n').trim(),
  };
  return { page, issues };
}
