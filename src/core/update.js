// 來源更新：來源有新版時，比對新舊版的差異，找出受影響的頁面。
//
// 舊版從 git 取得（每次 ingest 都把來源一起 commit）。行數引用（raw/x.c:L10-L20）會因為前面的增刪而位移，
// 這是純機械的計算，由這裡直接改寫頁面；引用的內容本身有變的頁面，交給 LLM 檢查。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, MARKDOWN_EXTENSIONS } from './constants.js';
import { git } from './git.js';
import { listHeadings } from './markdown.js';
import { locateSourceRef, parseSourceRef } from './sourceref.js';
import { splitLines } from './text.js';

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const sha256 = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const pagePath = (id) => `wiki/${id}.md`;
const span = (start, end) => (start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`);
const lineRef = (source, start, end, single) => (single && start === end ? `${source}:L${start}` : `${source}:L${start}-L${end}`);

export function contentHash(absPath) {
  return sha256(fs.readFileSync(absPath));
}

function toLines(text) {
  const lines = splitLines(text);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 解析 `git diff -U0` 的區塊標頭。
 * 沒有舊行（純新增）時 oldStart 是「新增在哪一行之後」；沒有新行（純刪除）時 newStart 是「刪除處的前一行」。
 * @returns {{ oldStart: number, oldCount: number, newStart: number, newCount: number }[]}
 */
export function parseHunks(diffText) {
  const hunks = [];
  for (const line of diffText.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) hunks.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return hunks;
}

/** 舊版第 line 行之前的變動，讓這一行往後（正）或往前（負）移了幾行。 */
function shiftBefore(hunks, line) {
  let shift = 0;
  for (const h of hunks) {
    const lastOld = h.oldCount ? h.oldStart + h.oldCount - 1 : h.oldStart;
    if (lastOld < line) shift += h.newCount - h.oldCount;
  }
  return shift;
}

/**
 * 舊版的行數範圍對應到新版的哪裡。
 * @returns {{ start: number, end: number, changed: boolean, deleted: boolean }} changed：範圍內的內容有變；deleted：整段都被刪掉了
 */
export function mapRange(hunks, start, end) {
  const touching = hunks.filter((h) => (h.oldCount ? h.oldStart <= end && h.oldStart + h.oldCount - 1 >= start : h.oldStart >= start && h.oldStart < end));
  if (touching.length === 0) {
    const shift = shiftBefore(hunks, start);
    return { start: start + shift, end: end + shift, changed: false, deleted: false };
  }
  // 範圍的頭或尾落在被改掉的區塊裡時，對齊到那個區塊在新版的位置
  const head = touching.find((h) => h.oldCount && h.oldStart <= start);
  const tail = touching.findLast((h) => h.oldCount && h.oldStart + h.oldCount - 1 >= end);
  const newStart = head ? (head.newCount ? head.newStart : head.newStart + 1) : start + shiftBefore(hunks, start);
  const newEnd = tail ? (tail.newCount ? tail.newStart + tail.newCount - 1 : tail.newStart) : end + shiftBefore(hunks, end);
  return { start: newStart, end: newEnd, changed: true, deleted: newEnd < newStart };
}

/**
 * 取得來源的新舊版與差異。
 * @returns {{ ok: true, oldLines: string[], newLines: string[], hunks: object[] } | { ok: false, reason: string }}
 */
function sourceDiff(root, source, knownHash) {
  const old = git(root, ['show', `HEAD:${source}`]);
  if (!old.ok || sha256(old.stdout) !== knownHash) return { ok: false, reason: '找不到上次處理時的來源內容，無法比對差異' };
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', source]);
  if (!diff.ok) return { ok: false, reason: `無法比對差異（${diff.stderr}）` };
  const hunks = parseHunks(diff.stdout);
  const oldLines = toLines(old.stdout);
  const newLines = toLines(fs.readFileSync(abs(root, source), 'utf8'));
  const changed = hunks.reduce((n, h) => n + h.oldCount + h.newCount, 0);
  if (hunks.length === 0) return { ok: false, reason: '新舊版沒有文字差異' };
  if (changed > (oldLines.length + newLines.length) * LIMITS.updateMaxChangeRatio || changed + hunks.length > LIMITS.updateDiffMaxLines) {
    return { ok: false, reason: `來源改動的幅度很大（變動 ${changed} 行），逐段比對沒有意義` };
  }
  return { ok: true, oldLines, newLines, hunks };
}

/**
 * 規劃一次來源更新，並把只是位移的行數引用直接改寫到頁面裡。
 * 引用一律取自 HEAD 版的頁面：重複執行不會位移兩次，在新版已經失效的引用也不會漏掉。
 * @param {string} root
 * @param {object} kb loadKb 的結果
 * @param {string} source 例如 raw/spec.md
 * @param {{ hash: string, pages: string[] }} known 對應表裡這份來源的紀錄：上次 ingest 時的 hash 與受它影響的頁面
 * @param {{ review: Record<string, string> } | null} prior 同一份來源先前已經規劃過時的紀錄
 * @returns {{ ok: false, reason: string } | { ok: true, text: string[], review: Record<string, string> }}
 *   text：給 LLM 看的說明；review：需要檢查的頁面代號 → 規劃當下的頁面內容 hash
 */
export function planUpdate(root, kb, source, known, prior) {
  const d = sourceDiff(root, source, known.hash);
  if (!d.ok) return d;
  const { oldLines, newLines, hunks } = d;
  const isMarkdown = MARKDOWN_EXTENSIONS.includes(path.extname(source).toLowerCase());
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refPattern = new RegExp(`${escaped}:L(\\d+)(?:-L(\\d+))?(?!\\d)`, 'g');
  // 章節引用只認清單項目（開頭欄位的 sources 與內文的「來源」段），內文其他地方的文字不算
  const sectionPattern = new RegExp(`^\\s*-\\s+["']?(${escaped}#[^"'\\n]+?)["']?\\s*$`, 'gm');

  const needReview = [];
  const shifted = [];
  const untouched = [];
  const covered = []; // 新版裡已經有頁面引用的行數範圍

  for (const id of [...known.pages].sort()) {
    const file = abs(root, pagePath(id));
    const head = git(root, ['show', `HEAD:${pagePath(id)}`]);
    if (!head.ok || !fs.existsSync(file)) continue;
    const notes = new Set(); // 同一個引用通常在開頭欄位與內文各出現一次
    let moved = 0;

    const rewritten = head.stdout.replace(refPattern, (whole, a, b) => {
      const start = Number(a);
      const end = b === undefined ? start : Number(b);
      if (end < start || end > oldLines.length) return whole;
      const r = mapRange(hunks, start, end);
      if (r.deleted) {
        notes.add(`${whole}：引用的內容在新版已經被刪除，請移除或改引用別處`);
        return whole;
      }
      covered.push([r.start, r.end]);
      const to = lineRef(source, r.start, r.end, b === undefined);
      if (r.changed) notes.add(`${whole}${to === whole ? '' : `（已改成 ${to}）`}：這個範圍的內容有變`);
      if (to !== whole) moved++;
      return to;
    });

    for (const ref of new Set([...head.stdout.matchAll(sectionPattern)].map((m) => m[1].trim()))) {
      const p = parseSourceRef(ref);
      if (!p.ok || p.kind !== 'section') continue;
      const before = locateSourceRef(p, oldLines);
      const after = locateSourceRef(p, newLines);
      if (!after.ok) notes.add(`${ref}：新版找不到這個章節，請改引用新的章節`);
      else {
        covered.push([after.startLine, after.endLine]);
        if (!before.ok || before.lines.join('\n') !== after.lines.join('\n')) notes.add(`${ref}：這個章節的內容有變（新版${span(after.startLine, after.endLine)}）`);
      }
    }

    const current = fs.readFileSync(file, 'utf8');
    if (current === head.stdout) {
      if (rewritten !== current) fs.writeFileSync(file, rewritten);
    } else if (!prior) {
      notes.add('這一頁在開始前就有尚未 commit 的修改，行數引用沒有自動調整，請自行確認');
    }
    const line = `- ${id}｜${kb.pages.get(id)?.title ?? '（這一頁目前有格式錯誤）'}`;
    if (notes.size) needReview.push({ id, text: [line, ...[...notes].map((n) => `    ${n}`)].join('\n') });
    else if (moved) shifted.push(line);
    else untouched.push(id);
  }

  const headings = isMarkdown ? listHeadings(newLines) : [];
  const sectionOf = (line) => headings.findLast((h) => h.line <= line)?.text ?? null;
  const added = hunks
    .filter((h) => h.newCount > 0 && !covered.some(([s, e]) => s <= h.newStart + h.newCount - 1 && e >= h.newStart))
    .map((h) => {
      const sec = sectionOf(h.newStart);
      return `- ${span(h.newStart, h.newStart + h.newCount - 1)}${sec ? `（章節：${sec}）` : ''}`;
    });

  const diffText = [];
  for (const h of hunks) {
    const sec = sectionOf(h.newStart);
    const was = h.oldCount ? `舊版${span(h.oldStart, h.oldStart + h.oldCount - 1)}` : h.oldStart ? `在舊版第 ${h.oldStart} 行之後` : '在舊版開頭';
    const now = h.newCount ? `新版${span(h.newStart, h.newStart + h.newCount - 1)}` : '新版已刪除';
    diffText.push(`@@ ${was} → ${now}${sec ? `（章節：${sec}）` : ''}`);
    diffText.push(...oldLines.slice(h.oldStart - 1, h.oldStart - 1 + h.oldCount).map((l) => `-        ${l}`));
    diffText.push(...newLines.slice(h.newStart - 1, h.newStart - 1 + h.newCount).map((l, i) => `+ ${String(h.newStart + i).padStart(5)}  ${l}`));
  }

  const review = prior?.review ?? Object.fromEntries(needReview.map((p) => [p.id, contentHash(abs(root, pagePath(p.id)))]));
  const text = [
    '== 來源的變更（- 是舊版被拿掉的行，+ 是新版加入的行，+ 後面的數字是新版的行數）==',
    ...diffText,
    '',
    '== 需要檢查的頁面（引用的內容有變）==',
    needReview.length ? needReview.map((p) => p.text).join('\n') : '（沒有）',
    '',
  ];
  if (shifted.length) text.push('== 已自動調整行數的頁面（引用的內容沒變，只是位置移動，不用處理）==', ...shifted, '');
  if (untouched.length) text.push(`== 沒有受影響的頁面（不用處理）==`, untouched.join('、'), '');
  if (added.length) text.push('== 新增的內容（沒有任何頁面引用）==', ...added, '');
  return { ok: true, text, review };
}
