// kb lint：第一層（程式）檢查。格式錯誤沿用 check，另外加上品質面的警告與檢索測試。
// 第二層（內容矛盾、過時資訊）需要 LLM 讀內容判斷，流程寫在維護 skill 裡。

import path from 'node:path';
import { checkKb } from './check.js';
import { isRepoRoot } from './git.js';
import { buildSearchIndex } from './indexgen.js';
import { listFiles } from './kb.js';
import { hashFile, readProvenance } from './provenance.js';
import { queryTestIssues } from './querytest.js';

const FIX = '修改頁面後執行：kb commit "一句話說明改了什麼"';

export function lintKb(root) {
  const { kb, issues } = checkKb(root);
  const warn = (code, file, message, example, next = FIX) => issues.push({ level: 'warn', code, file, line: null, message, example, next });
  const pages = [...kb.pages.values()];

  // 孤立頁面：沒有任何其他頁面連進來
  const inbound = new Set();
  for (const p of pages) for (const l of p.links) if (!l.kb && l.id !== p.id) inbound.add(l.id);
  if (pages.length > 1) {
    for (const p of pages) {
      if (!inbound.has(p.id)) warn('orphan-page', p.path, `孤立頁面：沒有任何頁面連到 ${p.id}`, `在相關頁面的「相關頁面」段落加上 [[${p.id}]]`);
    }
  }

  // 標題重複：可能是同一個主題被寫成兩頁
  const byTitle = new Map();
  for (const p of pages) byTitle.set(p.title.trim().toLowerCase(), [...(byTitle.get(p.title.trim().toLowerCase()) ?? []), p]);
  for (const group of byTitle.values()) {
    if (group.length > 1) warn('title-duplicate', group[0].path, `這些頁面的標題相同：${group.map((p) => p.id).join('、')}`, '確認是否為同一個主題。是的話合併成一頁並刪除另一頁；不是的話把標題改得能區分');
  }

  // 來源：沒被引用、尚未處理、處理後內容有變
  const cited = new Set(pages.flatMap((p) => p.sources.map((s) => s.path)));
  const prov = isRepoRoot(root) ? readProvenance(root) : null;
  for (const rel of kb.rawFiles) {
    const entry = prov?.sources[rel];
    if (prov && !entry) {
      warn('source-pending', rel, '這份來源還沒有處理', null, `執行：kb ingest start ${rel}`);
    } else if (entry && entry.hash !== hashFile(path.join(kb.root, ...rel.split('/')))) {
      warn('source-changed', rel, `這份來源在處理之後內容有更新，這些頁面可能過時：${entry.pages.join('、') || '（無）'}`, null, `執行：kb ingest start ${rel}`);
    } else if (!cited.has(rel)) {
      warn('source-uncited', rel, '沒有任何頁面引用這份來源', '確認是否漏寫 sources；不需要這份來源的話請維護者把它移出 raw/');
    }
  }

  // 沒被用到的圖片
  const used = new Set(pages.flatMap((p) => p.images.map((i) => i.path)));
  for (const rel of listFiles(kb.root, 'assets')) {
    if (!used.has(rel)) warn('asset-unused', rel, '沒有任何頁面使用這張圖片', `在相關頁面加上 ![說明這張圖的內容](${rel})；不需要的話請維護者刪除`);
  }

  // 檢索測試
  if (kb.meta && !issues.some((i) => i.level === 'error')) issues.push(...queryTestIssues(buildSearchIndex(kb), root, FIX));

  return { kb, issues };
}
