#!/usr/bin/env node
// kb：知識庫核心 CLI。輸出本身就是引導，每個錯誤都附下一步。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  checkKb, findKbRoot, formatReport, loadKb, readSearchIndex, readTextFile, resolveSourceRef,
  searchWiki, staleIndexes, toPosix, validatePage, writeIndexes, pathToPageId, listFiles,
  initKb, ingestAbort, ingestCommit, ingestKeep, ingestPart, ingestStart, ingestStatus,
  cloneKb, pullKb, pushKb, shareKb,
  changes, editCommit, git, isRepoRoot, lintKb, queryTestAdd, queryTestRemove, queryTestRun, undoLast,
  configGet, configPath, configSet, configUnset, mountAdd, mountDisable, mountEnable, mountList, mountRemove,
} from '../core/index.js';

const USAGE = `用法：kb <指令> [參數] [--kb <知識庫路徑>]

維護指令：
  init <資料夾> --name --title --description --owner --category --confidentiality
                        建立新的知識庫
  ingest start [來源檔] 開始處理一份來源；不給來源檔則列出待處理的來源
  ingest part <段數>    讀取來源的第幾段（來源較長時）
  ingest keep <頁面代號...>  更新來源時：這些需要檢查的頁面看過了，不用改
  ingest commit         檢查頁面，通過後更新索引與紀錄並 commit
  ingest status         顯示目前處理到哪裡
  ingest abort          放棄這次處理，把 wiki/ 還原到上一次 commit

  commit "<說明>"       commit 與來源無關的頁面修改（修錯字、補關鍵字、修 lint 問題）
  undo                  撤銷最近一次 ingest 或 commit
  lint                  完整檢查：格式、孤立頁面、來源狀態、沒用到的圖片、檢索測試
  test                  執行檢索測試
  test add --terms "<關鍵字,關鍵字>" --expect <頁面代號> [--rank <名次>]
                        新增檢索測試題
  test remove <題號>    移除檢索測試題

共享指令（共享資料夾上的儲存庫）：
  share <共享路徑>      第一次把知識庫放上共享資料夾，慣例路徑 <共享資料夾>/<代號>.git
  push                  把本機的變更推到共享位置
  pull                  取得共享位置上別人推送的變更
  clone <共享路徑> <資料夾>  從共享位置取得工作複本（其他維護者用）

使用端指令（設定 wiki MCP 要掛載哪些知識庫，不需要在知識庫資料夾內執行）：
  mount list            列出設定檔裡的知識庫與檢查結果
  mount add <路徑>      加入知識庫：本機的知識庫資料夾，或共享資料夾上的 <代號>.git
  mount remove <代號或路徑>   從設定檔移除（不會刪除知識庫的檔案）
  mount disable <代號或路徑>  暫時不掛載，設定保留
  mount enable <代號或路徑>   重新啟用
  config get [項目]     顯示設定：max_confidentiality、cache_dir
  config set <項目> <值>      修改設定；調高 max_confidentiality 要加 --yes
  config unset <項目>   回到預設值
  config path           顯示設定檔位置
                        設定檔不存在時自動建立；可用 --config <路徑> 指定其他設定檔

查詢與檢查指令：
  check                 只檢查格式（格式、連結、來源引用、索引是否過期）
  validate <頁面檔>     檢查單一頁面；加 --draft 表示尚未由腳本填 updated
  rebuild               重新產生 index.md 與 .kb/search-index.json
  search <關鍵字...>    搜尋頁面；可加 --limit <筆數>
  info                  顯示知識庫名片與頁數
  resolve <來源引用>    顯示來源引用所指的內容，例如 raw/spec.md#3.2

沒有指定 --kb 時，從目前資料夾往上找 kb.json。`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') opts.draft = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function fail(message, next) {
  console.error(`[錯誤] ${message}`);
  if (next) console.error(`  下一步：${next}`);
  process.exit(2);
}

function needRoot(opts) {
  const root = opts.kb ? path.resolve(opts.kb) : findKbRoot(process.cwd());
  if (!root || !fs.existsSync(path.join(root, 'kb.json'))) {
    fail(`找不到知識庫（${opts.kb ?? '目前資料夾及其上層'}沒有 kb.json）`, '切換到知識庫資料夾，或加上 --kb <知識庫路徑>');
  }
  return root;
}

const done = (r) => {
  (r.code === 0 ? console.log : console.error)(r.text);
  return r.code;
};

const commands = {
  init(opts) {
    return done(initKb(opts._[0], opts));
  },

  ingest(opts) {
    const sub = opts._.shift();
    const subs = { start: ingestStart, part: ingestPart, commit: ingestCommit, status: ingestStatus, abort: ingestAbort };
    if (sub === 'keep') return done(ingestKeep(needRoot(opts), opts._));
    if (!subs[sub]) fail(`ingest 後面要接 start、part、keep、commit、status、abort 其中之一${sub ? `，目前是「${sub}」` : ''}`, '開始處理來源：kb ingest start <來源檔>');
    return done(subs[sub](needRoot(opts), opts._[0]));
  },

  share(opts) {
    return done(shareKb(needRoot(opts), opts._[0]));
  },

  push(opts) {
    return done(pushKb(needRoot(opts)));
  },

  pull(opts) {
    return done(pullKb(needRoot(opts)));
  },

  clone(opts) {
    return done(cloneKb(opts._[0], opts._[1]));
  },

  mount(opts) {
    const sub = opts._.shift();
    const subs = { list: mountList, add: mountAdd, remove: mountRemove, enable: mountEnable, disable: mountDisable };
    if (!subs[sub]) fail(`mount 後面要接 list、add、remove、enable、disable 其中之一${sub ? `，目前是「${sub}」` : ''}`, '看目前掛載了哪些知識庫：kb mount list');
    return done(subs[sub]({ config: opts.config }, opts._[0]));
  },

  config(opts) {
    const sub = opts._.shift();
    const where = { config: opts.config };
    if (sub === 'path') return done(configPath(where));
    if (sub === 'get') return done(configGet(where, opts._[0]));
    if (sub === 'set') return done(configSet(where, opts._[0], opts._[1], { yes: opts.yes }));
    if (sub === 'unset') return done(configUnset(where, opts._[0], { yes: opts.yes }));
    fail(`config 後面要接 get、set、unset、path 其中之一${sub ? `，目前是「${sub}」` : ''}`, '看目前的設定：kb config get');
  },

  commit(opts) {
    return done(editCommit(needRoot(opts), opts._.join(' ') || opts.m));
  },

  undo(opts) {
    return done(undoLast(needRoot(opts)));
  },

  test(opts) {
    const root = needRoot(opts);
    const sub = opts._.shift();
    if (sub === 'add') return done(queryTestAdd(root, opts));
    if (sub === 'remove') return done(queryTestRemove(root, opts._[0]));
    if (sub && sub !== 'run') fail(`test 後面只能接 add、remove，或不接（執行測試），目前是「${sub}」`, 'kb test');
    return done(queryTestRun(root));
  },

  lint(opts) {
    const root = needRoot(opts);
    const { kb, issues } = lintKb(root);
    console.log(formatReport(issues, `結果：合格。${kb.pages.size} 頁、${kb.rawFiles.length} 份來源，沒有問題。`));
    if (!issues.some((i) => i.level === 'error')) {
      console.log('\n以上是程式能檢查的部分。內容是否互相矛盾、是否過時，需要另外讀頁面判斷（見維護 skill 的「內容檢查」）。');
    }
    return issues.some((i) => i.level === 'error') ? 1 : 0;
  },

  check(opts) {
    const root = needRoot(opts);
    const { kb, issues } = checkKb(root);
    console.log(formatReport(issues, `結果：合格。${kb.pages.size} 頁、${kb.rawFiles.length} 份來源，沒有問題。`));
    return issues.some((i) => i.level === 'error') ? 1 : 0;
  },

  validate(opts) {
    const root = needRoot(opts);
    const file = opts._[0];
    if (!file) fail('沒有指定頁面檔', 'kb validate wiki/<分類>/<名稱>.md');
    let abs = path.resolve(file);
    if (!fs.existsSync(abs)) abs = path.join(root, file);
    if (!fs.existsSync(abs)) fail(`找不到檔案 ${file}`, '路徑從知識庫根目錄寫起，例如 kb validate wiki/uart/baud-rate.md');
    const relPath = toPosix(path.relative(root, abs));
    const f = readTextFile(abs);
    if (!f.ok) fail(`${relPath} 不是 UTF-8 文字檔`, '另存成 UTF-8（無 BOM）後再試');
    const ids = new Set(listFiles(root, 'wiki').map(pathToPageId).filter(Boolean));
    const { issues } = validatePage({ kbRoot: root, relPath, text: f.text, mode: opts.draft ? 'draft' : 'stored', hasPage: (id) => ids.has(id) });
    console.log(formatReport(issues, `結果：合格。${relPath} 沒有問題。`));
    return issues.some((i) => i.level === 'error') ? 1 : 0;
  },

  rebuild(opts) {
    const root = needRoot(opts);
    const kb = loadKb(root);
    const errors = kb.issues.filter((i) => i.level === 'error');
    if (errors.length) {
      console.log(formatReport(kb.issues, ''));
      console.log('\n沒有重建索引：知識庫有錯誤時不產生索引。修正後再執行：kb rebuild');
      return 1;
    }
    const stale = staleIndexes(kb);
    writeIndexes(kb);
    console.log(stale.length ? `已重建：${stale.join('、')}（共 ${kb.pages.size} 頁）` : `索引已是最新，沒有變更（共 ${kb.pages.size} 頁）`);
    // 知識庫是 git repo 時，把重建的索引做成 commit；頁面有未 commit 的變更時留給下一次 commit 一起處理
    if (stale.length && isRepoRoot(root)) {
      const ch = changes(root);
      if (ch.some((c) => c.path.startsWith('wiki/'))) {
        console.log('wiki/ 有尚未 commit 的頁面變更，索引會在下一次 kb ingest commit 或 kb commit 時一起 commit。');
      } else if (ch.some((c) => stale.includes(c.path))) {
        let r = git(root, ['add', '--', ...stale]);
        if (r.ok) r = git(root, ['commit', '-q', '-m', 'rebuild: index', '--', ...stale]);
        console.log(r.ok ? '已 commit：rebuild: index' : `注意：git commit 失敗（${r.stderr}），請維護者處理。`);
      }
    }
    return 0;
  },

  search(opts) {
    const root = needRoot(opts);
    if (opts._.length === 0) fail('沒有給關鍵字', 'kb search <關鍵字> [更多關鍵字...]，多個關鍵字任一命中即算');
    const index = readSearchIndex(root);
    if (!index) fail('找不到搜尋索引 .kb/search-index.json', '執行：kb rebuild');
    const { results, total } = searchWiki([index], opts._, { limit: opts.limit ? Number(opts.limit) : undefined });
    if (total === 0) {
      console.log(`查無結果：${opts._.join('、')}`);
      console.log('  下一步：換同義詞、英文或縮寫再搜尋；或看 index.md 的目錄挑頁面');
      return 0;
    }
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${r.id}  ${r.title}  （分數 ${r.score}，命中：${r.where.join('、')}）`);
      console.log(`   ${r.summary}`);
      if (r.snippet) console.log(`   > ${r.snippet}`);
    });
    if (total > results.length) console.log(`\n共 ${total} 筆，只顯示前 ${results.length} 筆。要看更多：加上 --limit ${total}，或用更精確的關鍵字`);
    return 0;
  },

  info(opts) {
    const root = needRoot(opts);
    const kb = loadKb(root);
    const m = kb.meta ?? {};
    const cats = new Map();
    for (const id of kb.pages.keys()) cats.set(id.split('/')[0], (cats.get(id.split('/')[0]) ?? 0) + 1);
    console.log(`代號：${m.name}\n名稱：${m.title}\n描述：${m.description}\n擁有者：${m.owner}\n分類：${m.category}\n結構版本：${m.schema_version}\n機密等級：${m.confidentiality}`);
    console.log(`頁數：${kb.pages.size}（${[...cats].map(([c, n]) => `${c} ${n}`).join('、')}）\n來源：${kb.rawFiles.length} 份`);
    return 0;
  },

  resolve(opts) {
    const root = needRoot(opts);
    const ref = opts._[0];
    if (!ref) fail('沒有給來源引用', 'kb resolve raw/spec.md#3.2 或 kb resolve raw/drv.c:L120-L180');
    const r = resolveSourceRef(root, ref);
    if (!r.ok) fail(`來源引用「${ref}」無效：${r.reason}`, r.hint);
    console.log(`${r.path} 第 ${r.startLine}-${r.endLine} 行${r.heading ? `（章節：${r.heading}）` : ''}`);
    console.log(r.lines.map((l, i) => `${String(r.startLine + i).padStart(5)}  ${l}`).join('\n'));
    return 0;
  },
};

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._.shift();
if (!cmd || opts.help) {
  console.log(USAGE);
  process.exit(cmd || opts.help ? 0 : 2);
}
if (!commands[cmd]) fail(`沒有「${cmd}」這個指令`, '執行 kb --help 看可用的指令');
process.exit(commands[cmd](opts));
