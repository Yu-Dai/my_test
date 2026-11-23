// 四個唯讀檢索工具。每個函式吃 (mounts, args)，回傳給模型看的文字。
// 回傳內容本身就是引導：查無結果、參數錯誤、輸出被截斷時，都說明下一步。

import path from 'node:path';
import {
  LIMITS, MARKDOWN_EXTENSIONS, listHeadings, parsePageId, parseSourceRef, readTextFile, resolveSourceRef,
  searchRaw, searchWiki, splitLines,
} from '../core/index.js';
import { CONFIG_EXAMPLE } from './config.js';

export const SERVER_INSTRUCTIONS = [
  '這是唯讀的 wiki 知識庫。回答問題前先查知識庫，典型流程：',
  '1. GetWikiInfo：看有哪些知識庫，以及知識庫的頁面目錄。',
  '2. SearchWiki：用關鍵字搜尋（中文、英文、縮寫都試），或直接從目錄挑頁面。',
  '3. ReadWiki：讀取頁面全文。頁面用「分類/名稱」這種代號指稱，例如 uart/baud-rate。',
  '4. 頁面內容不夠細時，用 FetchRaw 讀取頁面「來源」列出的原始檔段落。',
  '回答時註明依據的頁面代號。知識庫沒有的內容要明說查不到，不要自行編造。',
].join('\n');

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
const q = (s) => JSON.stringify(s);

function noMounts(mounts) {
  const out = ['目前沒有掛載任何知識庫。'];
  if (mounts.problems.length) out.push('', '問題：', ...mounts.problems.map((p) => `- ${p}`));
  out.push('', '下一步：請使用者檢查 wiki MCP 的設定檔，確認 knowledge_bases 列出的路徑存在且是知識庫資料夾。設定檔範例：', CONFIG_EXAMPLE);
  return out.join('\n');
}

/** 找出要用的知識庫。只掛載一個時可省略代號。 */
function pickKb(mounts, name) {
  if (mounts.all().length === 0) return { error: noMounts(mounts) };
  const names = mounts.names();
  if (name === undefined || name === null || name === '') {
    if (names.length === 1) return { kb: mounts.get(names[0]) };
    return { error: `需要指定 kb。可用的知識庫代號：${names.join('、')}` };
  }
  const kb = mounts.get(String(name).trim());
  if (!kb) return { error: `沒有「${name}」這個知識庫。可用的知識庫代號：${names.join('、')}\n下一步：改用上面其中一個代號再呼叫一次。` };
  return { kb };
}

function localTime(iso) {
  if (!iso) return '時間不明';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 共享知識庫在名片上註明快取日期。 */
function sharedNote(kb) {
  if (!kb.shared) return '';
  const checking = kb.shared.state === 'pending' || kb.shared.state === 'syncing' ? '，正在檢查更新' : '';
  return `｜共享（本機快取更新於 ${localTime(kb.shared.synced)}${checking}）`;
}

const pageLine = (p) => `- ${p.id}｜${p.title}｜${p.summary}`;

// ---------------------------------------------------------------- GetWikiInfo

export function getWikiInfo(mounts, args = {}) {
  mounts.refresh();
  if (mounts.all().length === 0) return noMounts(mounts);
  const category = args.category ? String(args.category).trim() : null;
  const offset = Math.max(0, Number(args.offset) || 0);

  if (!args.kb) {
    let kbs = mounts.all();
    if (category) {
      kbs = kbs.filter((k) => k.meta.category === category);
      if (kbs.length === 0) {
        const cats = [...new Set(mounts.all().map((k) => k.meta.category))];
        return `沒有分類為「${category}」的知識庫。現有的知識庫分類：${cats.join('、')}\n下一步：不帶參數呼叫 GetWikiInfo 看全部知識庫。`;
      }
    }
    const out = [`已掛載 ${kbs.length} 個知識庫${category ? `（分類 ${category}）` : ''}：`, ''];
    for (const k of kbs) {
      out.push(`- 代號 ${k.name}｜${k.meta.title}｜分類 ${k.meta.category}｜${k.pages.size} 頁${sharedNote(k)}`);
      out.push(`  ${k.meta.description}`);
      if (k.shared?.state === 'failed') out.push(`  注意：這次無法從共享資料夾更新（${k.shared.error}），目前使用的是本機快取，內容可能不是最新的。`);
    }
    if (mounts.problems.length) out.push('', '注意，以下知識庫沒有掛載成功（請轉告使用者）：', ...mounts.problems.map((p) => `- ${p}`));
    out.push('', `下一步：SearchWiki(terms=["關鍵字"]) 搜尋全部知識庫；或 GetWikiInfo(kb=${q(kbs[0].name)}) 看該庫的頁面目錄。`);
    return out.join('\n');
  }

  const { kb, error } = pickKb(mounts, args.kb);
  if (error) return error;
  const byCat = new Map();
  for (const p of kb.pageList) {
    const c = p.id.split('/')[0];
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  const head = `知識庫 ${kb.name}｜${kb.meta.title}｜共 ${kb.pages.size} 頁`;
  const readHint = `下一步：ReadWiki(kb=${q(kb.name)}, pages=["分類/名稱"]) 讀取頁面；或 SearchWiki(terms=["關鍵字"], kb=${q(kb.name)}) 搜尋。`;

  if (category) {
    const pages = byCat.get(category);
    if (!pages) return `知識庫 ${kb.name} 沒有「${category}」這個分類。現有分類：${[...byCat.keys()].join('、')}\n下一步：改用上面其中一個分類再呼叫一次。`;
    const shown = pages.slice(offset, offset + LIMITS.indexMaxLines);
    const out = [head, '', `分類 ${category}（${pages.length} 頁${pages.length > shown.length ? `，顯示第 ${offset + 1}-${offset + shown.length} 頁` : ''}）：`, ...shown.map(pageLine), ''];
    if (offset + shown.length < pages.length) out.push(`還有 ${pages.length - offset - shown.length} 頁沒列出：再呼叫一次並加上 offset=${offset + shown.length}。`);
    out.push(readHint);
    return out.join('\n');
  }

  if (kb.pages.size > LIMITS.indexFlatMaxPages) {
    const out = [head, '', '頁面較多，先列出分類大綱：', ...[...byCat].map(([c, ps]) => `- ${c}（${ps.length} 頁）`), ''];
    out.push(`下一步：GetWikiInfo(kb=${q(kb.name)}, category="分類") 列出該分類的頁面；或 SearchWiki(terms=["關鍵字"], kb=${q(kb.name)}) 直接搜尋。`);
    return out.join('\n');
  }

  const out = [head, kb.meta.description, ''];
  for (const [c, ps] of byCat) out.push(`分類 ${c}（${ps.length} 頁）：`, ...ps.map(pageLine), '');
  if (kb.pages.size === 0) out.push('這個知識庫還沒有頁面。', '');
  out.push(readHint);
  return out.join('\n');
}

// ----------------------------------------------------------------- SearchWiki

export function searchWikiTool(mounts, args = {}) {
  mounts.refresh();
  if (mounts.all().length === 0) return noMounts(mounts);
  const terms = asList(args.terms);
  if (terms.length === 0) return '缺少 terms。請給一個或多個關鍵字，任一命中即算。\n正確寫法：SearchWiki(terms=["鮑率", "baud rate"])';
  const scope = args.scope ? String(args.scope).trim() : 'wiki';
  if (scope !== 'wiki' && scope !== 'raw') return `scope 只能是 "wiki"（搜尋整理過的頁面，預設）或 "raw"（搜尋原始來源檔），目前是 ${q(scope)}。`;

  let kbs = mounts.all();
  if (args.kb) {
    const { kb, error } = pickKb(mounts, args.kb);
    if (error) return error;
    kbs = [kb];
  }
  const limit = Math.min(Math.max(1, Number(args.limit) || LIMITS.searchDefaultLimit), LIMITS.searchMaxLimit);
  const offset = Math.max(0, Number(args.offset) || 0);
  const where = args.kb ? `知識庫 ${kbs[0].name}` : `全部 ${kbs.length} 個知識庫`;
  const label = `搜尋「${terms.join('、')}」（${where}，${scope === 'raw' ? '原始來源檔' : '頁面'}）`;

  const found = scope === 'wiki'
    ? searchWiki(kbs.map((k) => k.index), terms, { limit: offset + limit })
    : searchRaw(kbs.map((k) => ({ kb: k.name, files: mounts.rawTexts(k) })), terms, { limit: offset + limit });
  const shown = found.results.slice(offset);

  if (shown.length === 0) {
    const out = [`${label}：${found.total === 0 ? '查無結果' : `共 ${found.total} 筆，offset=${offset} 已超過範圍`}。`, '', '下一步（擇一）：'];
    out.push('- 換關鍵字再搜尋：同義詞、英文、縮寫、較短的詞。這裡是關鍵字比對，不是語意搜尋，也不支援 regex。');
    if (scope === 'wiki') out.push('- 加上 scope="raw" 搜尋原始來源檔。');
    if (args.kb) out.push('- 不指定 kb，搜尋全部知識庫。');
    out.push(`- 用 GetWikiInfo(kb=${q(kbs[0].name)}) 看頁面目錄，直接挑頁面。`);
    return out.join('\n');
  }

  const out = [`${label}：共 ${found.total} 筆，顯示第 ${offset + 1}-${offset + shown.length} 筆。`, ''];
  shown.forEach((r, i) => {
    if (scope === 'wiki') {
      out.push(`${offset + i + 1}. 知識庫 ${r.kb}｜頁面 ${r.id}｜${r.title}`);
      out.push(`   摘要：${r.summary}`);
      if (r.snippet) out.push(`   命中：${r.snippet}`);
    } else {
      out.push(`${offset + i + 1}. 知識庫 ${r.kb}｜${r.path}（${r.hitCount ? `命中 ${r.hitCount} 行` : '檔名命中'}）`);
      for (const h of r.hits) out.push(`   L${h.line}: ${h.text}`);
    }
  });
  out.push('');
  if (found.total > offset + shown.length) out.push(`還有 ${found.total - offset - shown.length} 筆：再呼叫一次並加上 offset=${offset + shown.length}，或改用更精確的關鍵字。`);
  const first = shown[0];
  if (scope === 'wiki') out.push(`下一步：ReadWiki(kb=${q(first.kb)}, pages=[${q(first.id)}]) 讀取頁面全文。`);
  else {
    const at = first.hits[0]?.line ?? 1;
    out.push(`下一步：FetchRaw(kb=${q(first.kb)}, path=${q(first.path)}, start_line=${Math.max(1, at - 10)}, end_line=${at + 30}) 讀取命中位置前後的內容。`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------- ReadWiki

/** 寬鬆接受各種頁面代號寫法：[[a/b|文字]]、kb:a/b、wiki/a/b.md。 */
export function normalizePageRef(ref) {
  let s = String(ref).trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  s = s.split('|')[0].trim().split('\\').join('/');
  let kb = null;
  const colon = s.indexOf(':');
  if (colon > 0 && !s.slice(0, colon).includes('/')) {
    kb = s.slice(0, colon);
    s = s.slice(colon + 1);
  }
  s = s.replace(/^\/+/, '').replace(/^wiki\//, '').replace(/\.md$/i, '').toLowerCase();
  return { kb, id: s };
}

function suggestPages(kb, id) {
  const [cat, name] = id.includes('/') ? id.split('/') : [null, id];
  const hits = kb.pageList.filter((p) => (name && p.id.split('/')[1].includes(name)) || (name && name.includes(p.id.split('/')[1])));
  const sameCat = kb.pageList.filter((p) => cat && p.id.startsWith(`${cat}/`));
  return [...new Set([...hits, ...sameCat])].slice(0, 8);
}

function renderPage(mounts, kb, page) {
  const body = page.body.replace(/(!\[[^\]\n]*\]\()assets\//g, `$1kb://${kb.name}/assets/`);
  const out = [`===== 知識庫 ${kb.name}｜頁面 ${page.id} =====`, `標題：${page.title}`, `類型：${page.type}｜更新：${page.updated ?? '未知'}`, `摘要：${page.summary}`, '', body, ''];
  const seen = new Set();
  const linkLines = [];
  for (const l of page.links) {
    const key = `${l.kb ?? ''}:${l.id}`;
    if (seen.has(key) || (!l.kb && l.id === page.id)) continue;
    seen.add(key);
    const targetKb = l.kb ? mounts.get(l.kb) : kb;
    const target = targetKb?.pages.get(l.id);
    if (target) linkLines.push(`- ${l.kb ? `${l.kb}:` : ''}${target.id}｜${target.title}｜${target.summary}`);
    else if (l.kb && !targetKb) linkLines.push(`- ${l.kb}:${l.id}（知識庫 ${l.kb} 沒有掛載）`);
    else linkLines.push(`- ${l.kb ? `${l.kb}:` : ''}${l.id}（頁面不存在）`);
  }
  if (linkLines.length) out.push('--- 本頁連到的頁面（可用 ReadWiki 讀取）---', ...linkLines, '');
  if (page.sources.length) out.push('--- 本頁的來源（可用 FetchRaw 讀取，path 直接填下面的寫法）---', ...page.sources.map((s) => `- ${s.ref}`), '');
  return out.join('\n');
}

export function readWiki(mounts, args = {}) {
  mounts.refresh();
  if (mounts.all().length === 0) return noMounts(mounts);
  const refs = asList(args.pages ?? args.page);
  if (refs.length === 0) return '缺少 pages。請給一個或多個頁面代號（分類/名稱）。\n正確寫法：ReadWiki(kb="知識庫代號", pages=["uart/baud-rate"])\n不知道代號時先用 GetWikiInfo 或 SearchWiki。';

  const parts = [];
  const problems = [];
  const deferred = [];
  let used = 0;
  for (const ref of refs) {
    const n = normalizePageRef(ref);
    const { kb, error } = pickKb(mounts, n.kb ?? args.kb);
    if (error) {
      problems.push(`「${ref}」：${error}`);
      continue;
    }
    if (!parsePageId(n.id)) {
      problems.push(`「${ref}」不是合法的頁面代號。頁面代號是「分類/名稱」，例如 ${kb.pageList[0]?.id ?? 'uart/baud-rate'}。`);
      continue;
    }
    const page = kb.pages.get(n.id);
    if (!page) {
      const sug = suggestPages(kb, n.id);
      problems.push(`知識庫 ${kb.name} 沒有頁面「${n.id}」。${sug.length ? `相近的頁面：\n${sug.map(pageLine).join('\n')}` : `用 SearchWiki(terms=["關鍵字"], kb=${q(kb.name)}) 找正確的代號。`}`);
      continue;
    }
    let text = renderPage(mounts, kb, page);
    if (used > 0 && used + text.length > LIMITS.readMaxChars) {
      deferred.push({ kb: kb.name, id: page.id });
      continue;
    }
    if (text.length > LIMITS.readMaxChars) {
      text = `${text.slice(0, LIMITS.readMaxChars)}\n\n（這一頁超過輸出上限，後面的內容被截斷。需要細節時用 FetchRaw 讀取來源：${page.sources.map((s) => s.ref).join('、')}）\n`;
    }
    used += text.length;
    parts.push(text);
  }

  if (problems.length) parts.push(['--- 沒有讀到的頁面 ---', ...problems].join('\n'), '');
  if (deferred.length) {
    const byKb = new Map();
    for (const d of deferred) byKb.set(d.kb, [...(byKb.get(d.kb) ?? []), d.id]);
    parts.push(['--- 因輸出上限尚未回傳的頁面，請再呼叫一次 ---', ...[...byKb].map(([k, ids]) => `ReadWiki(kb=${q(k)}, pages=[${ids.map(q).join(', ')}])`)].join('\n'), '');
  }
  return parts.join('\n').trimEnd();
}

// ------------------------------------------------------------------- FetchRaw

function numbered(lines, startLine) {
  return lines.map((l, i) => `${String(startLine + i).padStart(5)}  ${l}`);
}

export function fetchRaw(mounts, args = {}) {
  mounts.refresh();
  const { kb, error } = pickKb(mounts, args.kb);
  if (error) return error;
  const example = `FetchRaw(kb=${q(kb.name)}, path="raw/spec.md#3.2") 或 FetchRaw(kb=${q(kb.name)}, path="raw/drv.c", start_line=120, end_line=180)`;
  if (!args.path) return `缺少 path。\n正確寫法：${example}\n可用的來源檔：${kb.rawFiles.slice(0, 30).join('、') || '（沒有）'}`;

  // path 可以直接是來源引用（raw/x.md#章節、raw/x.c:L1-L20），也可以另外給 section 或行數
  let ref = String(args.path).trim().split('\\').join('/').replace(/^\.?\/+/, '');
  if (!ref.startsWith('raw/')) ref = `raw/${ref}`;
  let filePath = ref;
  let section = args.section ? String(args.section).trim().replace(/^#/, '') : null;
  let start = Number(args.start_line) || null;
  let end = Number(args.end_line) || null;
  const parsed = parseSourceRef(ref);
  if (parsed.ok) {
    filePath = parsed.path;
    if (parsed.kind === 'section') section ??= parsed.anchor;
    else {
      start ??= parsed.start;
      end ??= parsed.end;
    }
  }

  if (!kb.rawFiles.includes(filePath)) {
    const base = path.posix.basename(filePath).toLowerCase();
    const near = kb.rawFiles.filter((f) => f.toLowerCase().includes(base) || base.includes(path.posix.basename(f).toLowerCase()));
    const list = (near.length ? near : kb.rawFiles).slice(0, 30);
    return `知識庫 ${kb.name} 沒有來源檔「${filePath}」。${near.length ? '相近的檔案' : '可用的來源檔'}：${list.join('、') || '（沒有）'}\n下一步：改用上面的路徑再呼叫一次。FetchRaw 只能讀 raw/ 底下的檔案。`;
  }
  const file = readTextFile(path.join(kb.root, ...filePath.split('/')));
  if (!file.ok) return `${filePath} 不是 UTF-8 文字檔，無法讀取。`;
  const all = splitLines(file.text);
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const total = all.length;

  let heading = null;
  if (section) {
    const r = resolveSourceRef(kb.root, `${filePath}#${section}`);
    if (!r.ok) return `${r.reason}\n${r.hint ?? ''}\n下一步：改用上面列出的章節，或用 start_line 與 end_line 指定行數（全檔共 ${total} 行）。`;
    start = r.startLine;
    end = r.endLine;
    heading = r.heading;
  } else if (start === null) {
    // 沒有指定位置：小檔案整份回傳，大的 markdown 回章節大綱
    const headings = MARKDOWN_EXTENSIONS.includes(path.extname(filePath).toLowerCase()) ? listHeadings(all) : [];
    if (total > LIMITS.rawMaxLines && headings.length) {
      const out = [`知識庫 ${kb.name}｜${filePath}｜全檔共 ${total} 行，內容較長，先列出章節：`, ''];
      out.push(...headings.slice(0, 200).map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}（第 ${h.line} 行）`), '');
      out.push(`下一步：FetchRaw(kb=${q(kb.name)}, path=${q(filePath)}, section="章節編號或標題") 讀取指定章節。`);
      return out.join('\n');
    }
    start = 1;
    end = total;
  }
  if (start < 1 || start > total) return `start_line=${start} 超出範圍，${filePath} 全檔共 ${total} 行。`;
  end = Math.min(end ?? start + LIMITS.rawMaxLines - 1, total);
  if (end < start) return `行數範圍顛倒：start_line=${start}、end_line=${end}。`;

  // 輸出上限：行數與字數
  let cut = Math.min(end, start + LIMITS.rawMaxLines - 1);
  let chars = 0;
  for (let i = start; i <= cut; i++) {
    chars += all[i - 1].length + 8;
    if (chars > LIMITS.rawMaxChars && i > start) {
      cut = i - 1;
      break;
    }
  }
  const out = [`知識庫 ${kb.name}｜${filePath} 第 ${start}-${cut} 行${heading ? `（章節：${heading}）` : ''}｜全檔共 ${total} 行`, '', ...numbered(all.slice(start - 1, cut), start), ''];
  if (cut < end) out.push(`已達輸出上限，第 ${cut + 1}-${end} 行尚未回傳。繼續讀取：FetchRaw(kb=${q(kb.name)}, path=${q(filePath)}, start_line=${cut + 1}, end_line=${end})`);
  return out.join('\n').trimEnd();
}
