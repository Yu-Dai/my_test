// query test：確定性的檢索測試，不需要 LLM。每次 commit 前自動執行，用來抓檢索退步。
//
// .kb/query-tests.json：
// { "schema_version": 1,
//   "tests": [ { "terms": ["鮑率", "baud"], "expect": ["uart/baud-rate"], "max_rank": 3 } ] }
// 意思是：用 terms 搜尋時，expect 的每一頁都要排在前 max_rank 名以內。

import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './constants.js';
import { git, isRepoRoot } from './git.js';
import { parsePageId } from './ids.js';
import { buildSearchIndex } from './indexgen.js';
import { loadKb } from './kb.js';
import { searchWiki } from './search.js';

export const QUERY_TESTS_PATH = '.kb/query-tests.json';
export const DEFAULT_MAX_RANK = 5;
const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
const abs = (root) => path.join(root, ...QUERY_TESTS_PATH.split('/'));
const ADD_EXAMPLE = 'kb test add --terms "鮑率,baud rate" --expect uart/baud-rate --rank 3';

/** @returns {{ tests: object[], error: string|null }} */
export function readQueryTests(root) {
  if (!fs.existsSync(abs(root))) return { tests: [], error: null };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs(root), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { tests: [], error: `${QUERY_TESTS_PATH} 不是合法的 JSON：${e.message}` };
  }
  if (!Array.isArray(data?.tests)) return { tests: [], error: `${QUERY_TESTS_PATH} 缺少 tests 清單` };
  for (const [i, t] of data.tests.entries()) {
    const ok = Array.isArray(t?.terms) && t.terms.length > 0 && t.terms.every((x) => typeof x === 'string' && x.trim())
      && Array.isArray(t.expect) && t.expect.length > 0 && t.expect.every((x) => parsePageId(x))
      && Number.isInteger(t.max_rank) && t.max_rank >= 1;
    if (!ok) return { tests: [], error: `${QUERY_TESTS_PATH} 第 ${i + 1} 題格式不對，每題要有 terms（關鍵字清單）、expect（頁面代號清單）、max_rank（正整數）` };
  }
  return { tests: data.tests, error: null };
}

function writeQueryTests(root, tests) {
  fs.mkdirSync(path.dirname(abs(root)), { recursive: true });
  const rows = tests.map((t) => `    ${JSON.stringify({ terms: t.terms, expect: t.expect, max_rank: t.max_rank })}`);
  fs.writeFileSync(abs(root), `{\n  "schema_version": ${SCHEMA_VERSION},\n  "tests": [${rows.length ? `\n${rows.join(',\n')}\n  ` : ''}]\n}\n`);
}

/**
 * @param {{ kb: string|null, pages: object[] }} index 搜尋索引
 * @returns {{ n: number, test: object, ok: boolean, ranks: { id: string, rank: number|null }[], top: string[] }[]}
 */
export function runQueryTests(index, tests) {
  return tests.map((test, i) => {
    const ids = searchWiki([index], test.terms, { limit: index.pages.length || 1 }).results.map((r) => r.id);
    const ranks = test.expect.map((id) => ({ id, rank: ids.includes(id) ? ids.indexOf(id) + 1 : null }));
    return { n: i + 1, test, ok: ranks.every((r) => r.rank !== null && r.rank <= test.max_rank), ranks, top: ids.slice(0, Math.max(test.max_rank, 3)) };
  });
}

export function describeFailure(r) {
  const why = r.ranks.filter((x) => x.rank === null || x.rank > r.test.max_rank).map((x) => `${x.id} ${x.rank === null ? '沒有被搜尋到' : `排在第 ${x.rank} 名`}`);
  return `第 ${r.n} 題：搜尋「${r.test.terms.join('、')}」時，${why.join('；')}（要求前 ${r.test.max_rank} 名）。目前前幾名：${r.top.join('、') || '（無結果）'}`;
}

/** 把失敗的題目轉成 issue，給 commit 與 lint 使用。 */
export function queryTestIssues(index, root, next) {
  const { tests, error } = readQueryTests(root);
  if (error) return [{ level: 'error', code: 'query-test-file', file: QUERY_TESTS_PATH, line: null, message: error, example: `用指令新增題目，不要手動編輯：${ADD_EXAMPLE}`, next }];
  return runQueryTests(index, tests).filter((r) => !r.ok).map((r) => ({
    level: 'error',
    code: 'query-test',
    file: QUERY_TESTS_PATH,
    line: null,
    message: `檢索測試沒過。${describeFailure(r)}`,
    example: `在預期頁面的 keywords 或 aliases 補上這些關鍵字，讓它搜尋得到。如果該頁已被刪除或改名、這一題不再適用：kb test remove ${r.n}`,
    next,
  }));
}

function commitTests(root, message) {
  if (!isRepoRoot(root)) return '';
  let r = git(root, ['add', '--', QUERY_TESTS_PATH]);
  if (r.ok) r = git(root, ['commit', '-q', '-m', message, '--', QUERY_TESTS_PATH]);
  return r.ok ? '' : `\n注意：測試題已寫入檔案，但 git commit 失敗（${r.stderr}）。請維護者處理。`;
}

const splitList = (v) => String(v ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);

export function queryTestRun(root) {
  const kb = loadKb(root);
  const { tests, error } = readQueryTests(root);
  if (error) return fail(error, `用指令新增題目：${ADD_EXAMPLE}`);
  if (tests.length === 0) return { code: 0, text: `還沒有檢索測試題。\n下一步：為重要的頁面新增題目，例如：${ADD_EXAMPLE}` };
  const results = runQueryTests(buildSearchIndex(kb), tests);
  const failed = results.filter((r) => !r.ok);
  const out = results.map((r) => `${r.ok ? '通過' : '失敗'} 第 ${r.n} 題：「${r.test.terms.join('、')}」→ ${r.ranks.map((x) => `${x.id}（${x.rank === null ? '沒搜尋到' : `第 ${x.rank} 名`}）`).join('、')}，要求前 ${r.test.max_rank} 名`);
  out.push('', failed.length ? `結果：${results.length} 題中 ${failed.length} 題失敗。` : `結果：${results.length} 題全部通過。`);
  if (failed.length) out.push('下一步：在預期頁面的 keywords 或 aliases 補上關鍵字，然後執行 kb commit "補關鍵字"；題目不再適用時用 kb test remove <題號> 移除。');
  return { code: failed.length ? 1 : 0, text: out.join('\n') };
}

export function queryTestAdd(root, opts) {
  const terms = splitList(opts.terms);
  const expect = splitList(opts.expect);
  const maxRank = opts.rank === undefined ? DEFAULT_MAX_RANK : Number(opts.rank);
  if (terms.length === 0 || expect.length === 0) return fail('需要 --terms（關鍵字，用逗號分隔）與 --expect（預期搜尋到的頁面代號）', ADD_EXAMPLE);
  if (!Number.isInteger(maxRank) || maxRank < 1) return fail('--rank 必須是正整數', ADD_EXAMPLE);
  const kb = loadKb(root);
  const unknown = expect.filter((id) => !kb.pages.has(id));
  if (unknown.length) return fail(`沒有這個頁面：${unknown.join('、')}`, '頁面代號是「分類/名稱」，用 kb search <關鍵字> 或 index.md 確認');
  const { tests, error } = readQueryTests(root);
  if (error) return fail(error, '請維護者還原這個檔案：git checkout HEAD -- .kb/query-tests.json');
  const test = { terms, expect, max_rank: maxRank };
  const [result] = runQueryTests(buildSearchIndex(kb), [test]);
  if (!result.ok) {
    return fail(`這一題現在就不會通過，沒有新增。${describeFailure({ ...result, n: tests.length + 1 })}`, '先在預期頁面的 keywords 或 aliases 補上這些關鍵字並 kb commit，或把 --rank 放寬，再新增一次');
  }
  tests.push(test);
  writeQueryTests(root, tests);
  const note = commitTests(root, `test: add #${tests.length} ${terms.join(',')}`);
  return { code: 0, text: `已新增第 ${tests.length} 題：搜尋「${terms.join('、')}」→ ${result.ranks.map((x) => `${x.id}（目前第 ${x.rank} 名）`).join('、')}，要求前 ${maxRank} 名。${note}` };
}

export function queryTestRemove(root, nArg) {
  const { tests, error } = readQueryTests(root);
  if (error) return fail(error, '請維護者還原這個檔案：git checkout HEAD -- .kb/query-tests.json');
  const n = Number(nArg);
  if (!Number.isInteger(n) || n < 1 || n > tests.length) return fail(`題號必須是 1 到 ${tests.length}`, '用 kb test 看目前的題目與題號');
  const [removed] = tests.splice(n - 1, 1);
  writeQueryTests(root, tests);
  const note = commitTests(root, `test: remove ${removed.terms.join(',')}`);
  return { code: 0, text: `已移除第 ${n} 題（「${removed.terms.join('、')}」→ ${removed.expect.join('、')}）。剩下 ${tests.length} 題，題號已重新編排。${note}` };
}
