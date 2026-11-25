// kb ingest：一次處理一份來源，一份來源一筆 commit。
//
// 流程：start（檢查來源、給內容與範本）→ LLM 直接在 wiki/ 新增或修改頁面 → commit（驗證、蓋 updated、
// 更新索引與對應表與 log、git commit）。驗證沒過就不 commit，LLM 原地修正後再執行 commit。
// index.md、log.md、.kb/ 只由這裡寫入。
//
// 來源有新版時（處理過、內容有變）start 進入更新模式：只給差異與受影響的頁面，見 update.js。
// 需要檢查的頁面要嘛被修改，要嘛用 kb ingest keep 聲明不用改，否則 commit 會擋下。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatReport } from './check.js';
import { queryTestIssues } from './querytest.js';
import { IMAGE_EXTENSIONS, LIMITS, MARKDOWN_EXTENSIONS, RAW_EXTENSIONS } from './constants.js';
import { changes, git, hasIdentity, headShort, isRepoRoot } from './git.js';
import { pathToPageId } from './ids.js';
import { buildSearchIndex, writeIndexes } from './indexgen.js';
import { LOG_PATH, STATE_PATH, TEMPLATE_DIR, appendLog, today } from './init.js';
import { loadKb } from './kb.js';
import { listHeadings } from './markdown.js';
import { PROVENANCE_PATH, hashFile, pendingSources, readProvenance, recordIngest, refreshPages, writeProvenance } from './provenance.js';
import { adoptImages } from './rawimages.js';
import { remoteStatus } from './remote.js';
import { searchWiki } from './search.js';
import { readTextFile, splitLines } from './text.js';
import { contentHash, planUpdate } from './update.js';

const PROTECTED = [LOG_PATH, PROVENANCE_PATH, '.kb/query-tests.json'];
const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
const abs = (root, rel) => path.join(root, ...rel.split('/'));

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(abs(root, STATE_PATH), 'utf8'));
  } catch {
    return null;
  }
}

function preflight(root) {
  if (!isRepoRoot(root)) {
    return fail(`${root} 不是 git repo。ingest 需要 git 來記錄每一次變更`, '新知識庫請用 kb init 建立；既有資料夾請維護者在該資料夾執行 git init 並做第一筆 commit');
  }
  return null;
}

function pendingText(root, kb) {
  const pending = pendingSources(root, kb.rawFiles, readProvenance(root));
  if (pending.length === 0) return { pending, text: 'raw/ 裡的來源都已經處理完了。' };
  const lines = pending.map((p) => `- ${p.path}（${p.state === 'new' ? '尚未處理' : '內容有更新'}）`);
  return { pending, text: `還有 ${pending.length} 份來源待處理：\n${lines.join('\n')}\n處理下一份：kb ingest start ${pending[0].path}` };
}

/** 讀取來源並切段。 */
function loadSource(root, source) {
  const file = readTextFile(abs(root, source));
  const lines = splitLines(file.text);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const parts = Math.max(1, Math.ceil(lines.length / LIMITS.ingestPartLines));
  return { lines, parts, isMarkdown: MARKDOWN_EXTENSIONS.includes(path.extname(source).toLowerCase()) };
}

function renderPart(source, src, n) {
  const start = (n - 1) * LIMITS.ingestPartLines + 1;
  const end = Math.min(n * LIMITS.ingestPartLines, src.lines.length);
  const out = [`== 來源內容 ${source} 第 ${n}/${src.parts} 段（第 ${start}-${end} 行，左邊是行數）==`];
  out.push(...src.lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`));
  return out.join('\n');
}

function normalizeSource(arg) {
  let s = String(arg).trim().split('\\').join('/').replace(/^\.\//, '');
  if (!s.startsWith('raw/')) s = `raw/${s}`;
  return s;
}

function writeState(root, state) {
  fs.mkdirSync(abs(root, '.kb'), { recursive: true });
  fs.writeFileSync(abs(root, STATE_PATH), `${JSON.stringify(state, null, 2)}\n`);
}

/** 更新模式下還沒處理的頁面：需要檢查，但既沒有修改也沒有聲明不用改。 */
function unreviewed(root, update) {
  return Object.entries(update.review)
    .filter(([id, hash]) => !update.kept.includes(id) && fs.existsSync(abs(root, `wiki/${id}.md`)) && contentHash(abs(root, `wiki/${id}.md`)) === hash)
    .map(([id]) => id);
}

function changedPages(ch) {
  return ch.filter((c) => c.path.startsWith('wiki/'));
}

// ---------------------------------------------------------------------- start

export function ingestStart(root, sourceArg) {
  const pre = preflight(root);
  if (pre) return pre;
  const kb = loadKb(root);
  if (!kb.meta) return fail('kb.json 不合格，無法開始', '執行 kb check 看詳細原因');

  if (!sourceArg) {
    const state = readState(root);
    const head = state ? `目前正在處理：${state.source}（寫完頁面後執行 kb ingest commit）\n\n` : '';
    return { code: 0, text: head + pendingText(root, kb).text + (kb.rawFiles.length === 0 ? '\nraw/ 是空的。請維護者先把來源文字檔放進 raw/。' : '') };
  }

  const source = normalizeSource(sourceArg);
  if (source.split('/').some((s) => s === '..' || s === '.' || s === '')) return fail(`來源路徑「${sourceArg}」不合法`, '路徑從知識庫根目錄寫起，例如 kb ingest start raw/spec.md');
  if (!fs.existsSync(abs(root, source)) || !fs.statSync(abs(root, source)).isFile()) {
    return fail(`找不到來源檔 ${source}`, `確認檔案已放進 raw/。目前 raw/ 有：${kb.rawFiles.join('、') || '（空的）'}`);
  }
  const ext = path.extname(source).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return fail(`${source} 是圖片，不用單獨處理`, '處理引用這張圖的 .md 來源時，圖片會自動搬到 assets/。執行 kb ingest start 看待處理的來源');
  }
  if (!RAW_EXTENSIONS.includes(ext)) {
    return fail(`raw/ 只收文字檔，不接受「${ext}」`, `請先把 ${source} 轉成 .md，把轉出的 .md 與圖片資料夾一起放進 raw/，並把原檔移出 raw/`);
  }
  const probe = readTextFile(abs(root, source));
  if (probe.binary) return fail(`${source} 是二進位內容，不是文字檔`, '請先轉成 .md 再放進 raw/');
  if (!probe.validUtf8) return fail(`${source} 不是 UTF-8 編碼`, '請維護者用編輯器把它另存成 UTF-8（無 BOM）再試一次');

  const state = readState(root);
  if (state && state.source !== source) {
    return fail(`上一份來源 ${state.source} 還沒處理完。一次只能處理一份來源`, '先完成它：kb ingest commit；或放棄它：kb ingest abort');
  }
  // 共享知識庫：別人推送了新變更時，先取得再開始，避免兩邊各做各的
  const rs = state ? { origin: null } : remoteStatus(root);
  if (rs.origin && rs.behind > 0) {
    return fail(`共享位置有 ${rs.behind} 筆別人推送的新變更`, `先執行 kb pull 取得，再執行 kb ingest start ${source}`);
  }
  const dirty = changedPages(changes(root));
  const started = state?.started ?? new Date().toISOString();
  writeState(root, { source, started });

  // 轉檔輸出的圖片：搬到 assets/，並把來源內的圖片路徑改寫
  const adopted = MARKDOWN_EXTENSIONS.includes(ext) ? adoptImages(root, source) : { moved: [], missing: [] };
  const src = loadSource(root, source);
  const hasImages = src.lines.some((l) => /!\[[^\]]*\]\(\s*assets\//.test(l));
  const prov = readProvenance(root);
  const known = prov.sources[source];
  const hash = hashFile(abs(root, source));

  // 可能相關的既有頁面：已引用這份來源的，加上用檔名與章節標題搜尋到的
  const citing = [...kb.pages.values()].filter((p) => p.sources.some((s) => s.path === source));
  const headings = src.isMarkdown ? listHeadings(src.lines) : [];
  const terms = [...path.basename(source, ext).split(/[-_.\s]+/), ...headings.map((h) => h.text.replace(/^\d+(?:\.\d+)*\.?\s+/, ''))].filter((t) => t.length >= 2).slice(0, 40);
  const found = terms.length ? searchWiki([buildSearchIndex(kb)], terms, { limit: LIMITS.ingestRelatedPages + citing.length }).results : [];
  const related = [...citing.map((p) => ({ id: p.id, title: p.title, summary: p.summary, cites: true })), ...found.filter((r) => !citing.some((p) => p.id === r.id)).slice(0, LIMITS.ingestRelatedPages)];
  const cats = [...new Set([...kb.pages.keys()].map((id) => id.split('/')[0]))];

  const notices = [];
  if (rs.origin && !rs.reachable) notices.push('注意：連不到共享位置，無法確認別人有沒有推送新變更。可以繼續作業，推送前再確認。');
  if (adopted.moved.length) notices.push(`已把這份來源引用的 ${adopted.moved.length} 張圖片搬到 ${path.posix.dirname(adopted.moved[0].to)}/，來源內的圖片路徑已改成 assets/ 開頭。`);
  if (adopted.missing.length) notices.push(`注意：來源引用了這些圖片，但找不到檔案：${adopted.missing.join('、')}。頁面不要引用這些圖；請維護者把圖片放到來源旁邊後重新執行 kb ingest start ${source}。`);
  if (dirty.length && !state?.update) notices.push(`注意：wiki/ 已經有尚未 commit 的變更（${dirty.map((c) => c.path).join('、')}），它們會算進這次 ingest。不想保留就先執行 kb ingest abort。`);
  const citeHow = src.isMarkdown ? `${source}#章節編號或標題，或 ${source}:L起-L迄` : `${source}:L起-L迄（行數看來源內容左邊的數字）`;
  const template = [
    '== 頁面範本 ==',
    fs.readFileSync(path.join(TEMPLATE_DIR, 'page.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd(),
    '',
    'type 只能是：summary（來源摘要）、entity（實體）、concept（概念）、howto（操作步驟）、comparison（比較）。',
    '',
  ];

  // 來源有新版：能比對差異就只處理受影響的部分，否則整份重做
  const update = known && known.hash !== hash ? planUpdate(root, kb, source, known, state?.update ?? null) : null;
  if (update?.ok) {
    writeState(root, { source, started, update: { review: update.review, kept: state?.update?.kept ?? [] } });
    return {
      code: 0,
      text: [
        `開始更新來源：${source}（新版共 ${src.lines.length} 行）。這份來源之前處理過，現在內容有更新，這次只處理有變動的部分。`,
        ...notices,
        '',
        '== 你要做的事 ==',
        '1. 讀下面「來源的變更」，了解新版改了什麼。',
        '2. 「需要檢查的頁面」逐頁打開 wiki/<代號>.md，對照變更決定要不要改：',
        '   - 內容或引用需要改：直接修改檔案。',
        '   - 看過之後確定不用改：執行 kb ingest keep <頁面代號>。',
        '3. 「新增的內容」是新版多出來、還沒有任何頁面引用的部分。值得記錄的就新增頁面，或補進既有頁面並在 sources 加上引用。',
        `   - sources 都要寫到位置。這份來源的寫法：${citeHow}`,
        '   - 檔名只能用小寫英數加連字號，中文寫在 title。不要寫 updated 欄位。',
        `4. 需要看新版的完整內容時：kb ingest part 1${src.parts > 1 ? ` … kb ingest part ${src.parts}` : ''}`,
        '5. 完成後執行：kb ingest commit',
        '   需要檢查的頁面如果沒有修改、也沒有執行 kb ingest keep，會被擋下。',
        '不要修改 index.md、log.md、.kb/、raw/ 裡的任何檔案，也不要自己執行 git 指令。',
        '',
        ...update.text,
        ...template,
        '下一步：處理完「需要檢查的頁面」與「新增的內容」後執行 kb ingest commit。',
      ].join('\n'),
    };
  }

  const out = [`開始處理來源：${source}（共 ${src.lines.length} 行，分 ${src.parts} 段）`];
  if (known) out.push(known.hash === hash ? '注意：這份來源之前處理過，而且內容沒有變。確定要重做再繼續。' : `這份來源之前處理過，現在內容有更新。${update.reason}，這次整份重新處理：請檢查下面「已引用這份來源」的頁面是否需要修改，引用的行數也要重新確認。`);
  out.push(...notices);
  out.push(
    '',
    '== 你要做的事 ==',
    '1. 先讀 SCHEMA.md（這個知識庫的分類方式與用語）。',
    `2. 讀完下面的來源內容。${src.parts > 1 ? `這裡只有第 1 段，其餘用 kb ingest part 2 … kb ingest part ${src.parts} 讀取，全部讀完再動手寫。` : ''}`,
    '3. 直接在 wiki/<分類>/<名稱>.md 新增或修改頁面，照下面的頁面範本寫。',
    '   - 這份來源寫一頁 type: summary 的摘要頁；其中重要的東西、觀念、步驟各自獨立成頁。',
    '   - 下面「可能相關的既有頁面」已經有的主題，打開該檔案修改，不要另開重複的頁面。',
    `   - 每一頁的 sources 都要寫到位置。這份來源的寫法：${citeHow}`,
    '   - 檔名只能用小寫英數加連字號，中文寫在 title。不要寫 updated 欄位。',
    ...(hasImages ? ['   - 來源裡有圖片。要把圖放進頁面時，路徑照來源裡的 assets/… 原樣複製，並寫 ![說明這張圖的內容](assets/…)。說明文字必填：你看不到圖，依圖片前後的文字與圖說來寫；前後文沒說明內容的圖就不要放。'] : []),
    '4. 寫完執行：kb ingest commit',
    '   它會檢查所有頁面。有錯誤就照訊息修正，再執行一次 kb ingest commit，直到通過。',
    '不要修改 index.md、log.md、.kb/、raw/ 裡的任何檔案，也不要自己執行 git 指令。',
    '',
    `== 現有分類 ==`,
    cats.length ? cats.join('、') : '（還沒有任何頁面，請依 SCHEMA.md 決定分類）',
    '',
    '== 可能相關的既有頁面（檔案在 wiki/<代號>.md）==',
    related.length ? related.map((p) => `- ${p.id}｜${p.title}｜${p.summary}${p.cites ? '【已引用這份來源】' : ''}`).join('\n') : '（沒有）',
    '',
    ...template,
  );
  if (headings.length) out.push('== 來源的章節 ==', ...headings.slice(0, 150).map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}（第 ${h.line} 行）`), '');
  out.push(renderPart(source, src, 1), '');
  out.push(src.parts > 1 ? `下一步：kb ingest part 2 讀取下一段（共 ${src.parts} 段）。` : '下一步：在 wiki/ 寫好頁面後執行 kb ingest commit。');
  return { code: 0, text: out.join('\n') };
}

// ----------------------------------------------------------------------- part

export function ingestPart(root, nArg) {
  const state = readState(root);
  if (!state) return fail('目前沒有正在處理的來源', '先執行：kb ingest start <來源檔>');
  if (!fs.existsSync(abs(root, state.source))) return fail(`來源檔 ${state.source} 不見了`, '放棄這次處理：kb ingest abort');
  const src = loadSource(root, state.source);
  const n = Number(nArg);
  if (!Number.isInteger(n) || n < 1 || n > src.parts) return fail(`段數必須是 1 到 ${src.parts}`, `例如：kb ingest part ${Math.min(2, src.parts)}`);
  const next = n < src.parts ? `下一步：kb ingest part ${n + 1} 讀取下一段。` : '下一步：來源已全部讀完。在 wiki/ 寫好頁面後執行 kb ingest commit。';
  return { code: 0, text: `${renderPart(state.source, src, n)}\n\n${next}` };
}

// ----------------------------------------------------------------------- keep

/** kb ingest keep：更新來源時，聲明某些需要檢查的頁面看過了、不用改。 */
export function ingestKeep(root, idArgs = []) {
  const state = readState(root);
  if (!state) return fail('目前沒有正在處理的來源', '先執行：kb ingest start <來源檔>');
  if (!state.update) return fail('kb ingest keep 只用在更新已處理過的來源時', '寫好頁面後直接執行：kb ingest commit');
  const ids = idArgs.map((a) => String(a).trim().split('\\').join('/').replace(/^wiki\//, '').replace(/\.md$/i, '')).filter(Boolean);
  const listed = Object.keys(state.update.review);
  if (ids.length === 0) return fail('沒有指定頁面代號', `kb ingest keep <頁面代號>。需要檢查的頁面：${listed.join('、') || '（沒有）'}`);
  const unknown = ids.filter((id) => !listed.includes(id));
  if (unknown.length) return fail(`${unknown.join('、')} 不在需要檢查的頁面裡`, `需要檢查的頁面：${listed.join('、') || '（沒有）'}`);
  state.update.kept = [...new Set([...state.update.kept, ...ids])];
  writeState(root, state);
  const left = unreviewed(root, state.update);
  return { code: 0, text: `已記錄：${ids.join('、')} 看過了，不用改。\n${left.length ? `還沒處理的頁面：${left.join('、')}` : '需要檢查的頁面都處理完了。下一步：kb ingest commit'}` };
}

// --------------------------------------------------------------------- status

export function ingestStatus(root) {
  const pre = preflight(root);
  if (pre) return pre;
  const state = readState(root);
  const kb = loadKb(root);
  const out = [];
  if (state) {
    const pages = changedPages(changes(root));
    if (state.update) {
      const left = unreviewed(root, state.update);
      out.push(`這次是更新已處理過的來源。${left.length ? `還沒處理的頁面（修改它，或執行 kb ingest keep <頁面代號>）：${left.join('、')}` : '需要檢查的頁面都處理完了。'}`);
    }
    out.push(`正在處理：${state.source}`, pages.length ? `已變更的頁面：\n${pages.map((c) => `- ${c.path}（${{ added: '新增', modified: '修改', deleted: '刪除' }[c.kind]}）`).join('\n')}` : '還沒有變更任何頁面。', '寫完後執行：kb ingest commit；要放棄：kb ingest abort', '');
  } else out.push('目前沒有正在處理的來源。', '');
  out.push(pendingText(root, kb).text);
  return { code: 0, text: out.join('\n') };
}

// ---------------------------------------------------------------------- abort

export function ingestAbort(root) {
  const pre = preflight(root);
  if (pre) return pre;
  const state = readState(root);
  const pages = changedPages(changes(root));
  if (!state && pages.length === 0) return { code: 0, text: '沒有需要放棄的內容：目前沒有正在處理的來源，wiki/ 也沒有未 commit 的變更。' };
  git(root, ['reset', '-q', '--', 'wiki']);
  git(root, ['checkout', '-q', 'HEAD', '--', 'wiki']);
  git(root, ['clean', '-fdq', '--', 'wiki']);
  fs.rmSync(abs(root, STATE_PATH), { force: true });
  const left = changedPages(changes(root));
  if (left.length) return fail(`有些變更無法還原：${left.map((c) => c.path).join('、')}`, '請維護者檢查 git 狀態');
  return {
    code: 0,
    text: [`已放棄${state ? `來源 ${state.source} 的處理` : '未 commit 的變更'}，wiki/ 已還原到上一次 commit 的狀態。`, pages.length ? `還原的頁面：${pages.map((c) => c.path).join('、')}` : '', 'raw/ 與 assets/ 的檔案沒有動。', '重新開始：kb ingest start <來源檔>'].filter(Boolean).join('\n'),
  };
}

// --------------------------------------------------------------------- commit

/** 在開頭欄位寫入 updated，並統一成 LF、無 BOM。 */
export function stampUpdated(text, date) {
  const lines = splitLines(text.replace(/^\ufeff/, ''));
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (lines[0].trimEnd() !== '---' || close === -1) return lines.join('\n');
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^updated\s*:/.test(l));
  if (at !== -1) lines[at] = `updated: ${date}`;
  else lines.splice(close, 0, `updated: ${date}`);
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function ingestId(hash) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${hash.slice(7, 11)}`;
}

export function ingestCommit(root) {
  const pre = preflight(root);
  if (pre) return pre;
  const state = readState(root);
  if (!state) return fail('目前沒有正在處理的來源，沒有東西可以 commit', '先執行：kb ingest start <來源檔>');
  const { source } = state;
  if (!fs.existsSync(abs(root, source))) return fail(`來源檔 ${source} 不見了`, '把來源檔放回 raw/；或放棄這次處理：kb ingest abort');
  return finalize(root, { kind: 'ingest', source, update: state.update ?? null, cmd: 'kb ingest commit' });
}

/** kb commit：與來源無關的頁面修改（修錯字、補關鍵字、修 lint 找到的問題）。 */
export function editCommit(root, noteArg) {
  const pre = preflight(root);
  if (pre) return pre;
  const state = readState(root);
  if (state) return fail(`正在處理來源 ${state.source}，這時候的頁面變更屬於那次 ingest`, '完成它：kb ingest commit；或放棄它：kb ingest abort');
  const note = String(noteArg ?? '').replace(/\s+/g, ' ').trim();
  if (!note) return fail('需要一句話說明這次改了什麼', '例如：kb commit "補上 baud-rate 頁面的關鍵字"');
  return finalize(root, { kind: 'edit', source: null, note, cmd: `kb commit "${note}"` });
}

/** 驗證、蓋 updated、重建索引、更新對應表與 log、git commit。ingest 與 edit 共用。 */
function finalize(root, { kind, source, note, update = null, cmd }) {
  if (!hasIdentity(root)) return fail('git 還沒設定使用者名稱與信箱，無法建立 commit', `請使用者先執行：git config --global user.name "姓名" 與 git config --global user.email "信箱"，再執行 ${cmd}`);

  const ch = changes(root).filter((c) => c.path !== STATE_PATH);
  const again = `修正後再執行：${cmd}`;

  // 只有 CLI 能寫的檔案被動過
  const touched = ch.filter((c) => PROTECTED.includes(c.path));
  if (touched.length) {
    return fail(`這些檔案只能由 kb 指令寫入，不可以手動修改：${touched.map((c) => c.path).join('、')}`, `還原它們：git checkout HEAD -- ${touched.map((c) => c.path).join(' ')}\n  ${again}`);
  }
  // raw 放進去之後不修改（這次的來源本身除外）
  const rawEdited = ch.filter((c) => c.path.startsWith('raw/') && c.path !== source && c.kind !== 'added');
  if (rawEdited.length) {
    return fail(`raw/ 裡的來源檔不可以修改或刪除：${rawEdited.map((c) => c.path).join('、')}`, `還原它們：git checkout HEAD -- ${rawEdited.map((c) => c.path).join(' ')}\n  ${again}`);
  }

  const pageChanges = changedPages(ch);
  // 更新來源時可以沒有頁面變更：看過之後都不用改，只需要記下已經處理到新版
  if (pageChanges.length === 0 && !update) {
    return kind === 'ingest'
      ? fail('wiki/ 沒有任何變更，還沒有寫頁面', `依 kb ingest start ${source} 的說明，在 wiki/<分類>/<名稱>.md 新增或修改頁面，再執行 kb ingest commit`)
      : fail('wiki/ 沒有任何變更，沒有東西可以 commit', '先修改 wiki/ 裡的頁面。要整理新的來源請用 kb ingest start');
  }

  // 驗證整個知識庫；這次動到的頁面還沒有 updated，用草稿模式
  const live = pageChanges.filter((c) => c.kind !== 'deleted');
  const kb = loadKb(root, { draftPaths: new Set(live.map((c) => c.path)) });
  const issues = [...kb.issues];
  const liveIds = live.map((c) => pathToPageId(c.path)).filter(Boolean);
  const citing = liveIds.filter((id) => kb.pages.get(id)?.sources.some((s) => s.path === source));
  for (const id of update ? unreviewed(root, update) : []) {
    issues.push({ level: 'error', code: 'update-unreviewed', file: `wiki/${id}.md`, line: null, message: `這一頁引用的來源內容有變，但頁面沒有修改`, example: `對照來源的變更修改這一頁；看過之後確定不用改，就執行 kb ingest keep ${id}`, next: again });
  }
  if (kind === 'ingest' && !update && citing.length === 0 && !issues.some((i) => i.level === 'error')) {
    issues.push({ level: 'error', code: 'ingest-no-citation', file: live[0]?.path ?? 'wiki/', line: null, message: `這次變更的頁面沒有任何一頁在 sources 引用 ${source}`, example: `sources:\n  - ${source}${MARKDOWN_EXTENSIONS.includes(path.extname(source).toLowerCase()) ? '#章節編號或標題' : ':L起-L迄'}`, next: again });
  }
  for (const c of ch.filter((x) => x.path.startsWith('assets/') && x.kind !== 'deleted')) {
    const size = fs.statSync(abs(root, c.path)).size;
    if (size > LIMITS.imageMaxBytes) {
      issues.push({ level: 'error', code: 'image-too-large', file: c.path, line: null, message: `圖片 ${Math.round(size / 1024)} KB，超過上限 ${Math.round(LIMITS.imageMaxBytes / 1024)} KB`, example: '請維護者把圖片縮小或壓縮後覆蓋原檔', next: again });
    }
  }
  // 格式都對了才跑檢索測試，抓檢索退步
  if (!issues.some((i) => i.level === 'error')) issues.push(...queryTestIssues(buildSearchIndex(kb), root, again));
  if (issues.some((i) => i.level === 'error')) {
    for (const i of issues) if (i.level === 'error') i.next = again;
    return { code: 1, text: `${formatReport(issues, '')}\n\n沒有 commit。頁面檔案都還在，直接修改有問題的檔案，然後再執行：${cmd}` };
  }

  // 通過：蓋 updated、重建索引、更新對應表與 log、commit
  const date = today();
  for (const c of live) fs.writeFileSync(abs(root, c.path), stampUpdated(fs.readFileSync(abs(root, c.path), 'utf8'), date));
  const final = loadKb(root);
  writeIndexes(final);
  const ids = (kind) => pageChanges.filter((c) => c.kind === kind).map((c) => pathToPageId(c.path) ?? c.path).sort();
  const hash = source ? hashFile(abs(root, source)) : `sha256:${crypto.randomBytes(4).toString('hex')}`;
  const ingest = { id: ingestId(hash), date, source, hash, created: ids('added'), updated: ids('modified'), deleted: ids('deleted') };
  const prov = readProvenance(root);
  writeProvenance(root, kind === 'ingest' ? recordIngest(prov, ingest, final.pages) : refreshPages(prov, final.pages));
  const summary = [
    ingest.created.length ? `- 新增 ${ingest.created.length} 頁：${ingest.created.join('、')}` : null,
    ingest.updated.length ? `- 更新 ${ingest.updated.length} 頁：${ingest.updated.join('、')}` : null,
    ingest.deleted.length ? `- 刪除 ${ingest.deleted.length} 頁：${ingest.deleted.join('、')}` : null,
  ].filter(Boolean);
  const subject = kind === 'ingest' ? source : note;
  appendLog(root, `${kind} | ${subject}`, [...summary, `- id：${ingest.id}`]);

  const paths = ['wiki', 'assets', source, 'index.md', LOG_PATH, '.kb/search-index.json', PROVENANCE_PATH].filter((p) => p && fs.existsSync(abs(root, p)));
  const message = `${kind}: ${subject} [${ingest.id}]`;
  let r = git(root, ['add', '-A', '--', ...paths]);
  if (r.ok) r = git(root, ['commit', '-q', '-m', message]);
  if (!r.ok) {
    git(root, ['reset', '-q']);
    git(root, ['checkout', '-q', 'HEAD', '--', ...PROTECTED.slice(0, 2)]);
    return fail(`git commit 失敗：${r.stderr}`, `頁面檔案都還在。請維護者排除 git 問題後再執行：${cmd}`);
  }
  fs.rmSync(abs(root, STATE_PATH), { force: true });

  const others = changes(root).filter((c) => !c.path.startsWith('raw/'));
  const warns = final.issues.filter((i) => i.level === 'warn');
  const out = [kind === 'ingest' ? `ingest 完成：${source}` : `已 commit：${note}`, ...summary, `- commit：${headShort(root)}（${message}）`];
  if (warns.length) out.push('', `有 ${warns.length} 個警告（不影響這次 commit）：`, ...warns.map((i) => `- ${i.file}：${i.message}`));
  if (others.length) out.push('', `以下變更不屬於 ingest，沒有納入 commit：${others.map((c) => c.path).join('、')}`);
  out.push('', pendingText(root, final).text);
  const rs = remoteStatus(root, { fetch: false });
  if (rs.origin && rs.ahead > 0) out.push('', `這個知識庫有共享位置，目前有 ${rs.ahead} 筆變更尚未推送。這一批都處理完後執行：kb push`);
  return { code: 0, text: out.join('\n') };
}
