// 轉檔工具的輸出通常是「一個 .md + 一個圖片資料夾」。維護者把整包丟進 raw/ 即可：
// ingest start 時把 .md 引用到的圖片搬到 assets/<來源檔名>/，並把 .md 內的圖片路徑改寫成 assets/…。
// 已經是 assets/ 開頭或外部網址的路徑不動，所以重複執行沒有副作用。

import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXTENSIONS } from './constants.js';
import { fenceMask } from './markdown.js';

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const MD_IMAGE = /!\[[^\[\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]*)(?:\s+"[^"]*")?\s*\)/dg;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;

/** 把檔名裡會弄壞 markdown 路徑的字元換成連字號。 */
const safeName = (name) => name.replace(/[\s()<>[\]"'#?%\\]+/g, '-').replace(/^-+|-+$/g, '') || 'image';

/** 圖片引用的寫法 → raw/ 內的檔案路徑；不是 raw/ 內的本機圖片時回傳 null。 */
function resolveTarget(root, source, written) {
  let t = written.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//') || t.startsWith('#')) return null;
  t = t.split(/[?#]/)[0].replace(/\\/g, '/');
  try {
    t = decodeURIComponent(t);
  } catch { /* 保留原樣 */ }
  if (t.startsWith('assets/') || t.startsWith('/')) return null;
  if (!IMAGE_EXTENSIONS.includes(path.posix.extname(t).toLowerCase())) return null;
  // 先當成相對於 .md 所在資料夾；找不到再當成從知識庫根目錄寫起
  const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(source), t))];
  if (t.startsWith('raw/')) candidates.push(path.posix.normalize(t));
  const inRaw = candidates.filter((c) => c.startsWith('raw/'));
  if (inRaw.length === 0) return null;
  const found = inRaw.find((c) => fs.existsSync(abs(root, c)) && fs.statSync(abs(root, c)).isFile());
  return { rel: found ?? inRaw[0], exists: Boolean(found) };
}

function sameContent(a, b) {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/** 搬完後把 raw/ 底下變空的資料夾移除（raw/ 本身保留）。 */
function pruneEmptyDirs(root, rel) {
  let dir = path.posix.dirname(rel);
  while (dir.startsWith('raw/')) {
    const p = abs(root, dir);
    if (!fs.existsSync(p) || fs.readdirSync(p).length > 0) break;
    fs.rmdirSync(p);
    dir = path.posix.dirname(dir);
  }
}

/**
 * 把 markdown 來源引用的 raw/ 內圖片搬到 assets/<來源檔名>/，並改寫來源內的路徑。
 * @param {string} root 知識庫根目錄
 * @param {string} source 來源檔，例如 raw/manual.md
 * @returns {{ moved: { from: string, to: string }[], missing: string[] }}
 */
export function adoptImages(root, source) {
  const file = abs(root, source);
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const mask = fenceMask(lines.map((l) => l.replace(/\r$/, '')));
  const folder = `assets/${safeName(path.posix.basename(source, path.posix.extname(source)))}`;
  const dest = new Map(); // raw 內的路徑 → assets 內的路徑
  const taken = new Set();
  const moved = [];
  const missing = new Set();

  const destFor = (rel) => {
    if (dest.has(rel)) return dest.get(rel);
    const ext = path.posix.extname(rel);
    const stem = safeName(path.posix.basename(rel, ext));
    let to = `${folder}/${stem}${ext.toLowerCase()}`;
    for (let n = 2; taken.has(to) || (fs.existsSync(abs(root, to)) && !sameContent(abs(root, rel), abs(root, to))); n++) {
      to = `${folder}/${stem}-${n}${ext.toLowerCase()}`;
    }
    taken.add(to);
    dest.set(rel, to);
    return to;
  };

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const blanked = lines[i].replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
    const edits = [];
    for (const re of [MD_IMAGE, HTML_IMAGE]) {
      for (const m of blanked.matchAll(re)) {
        const g = m[1] !== undefined ? 1 : m[2] !== undefined ? 2 : 0;
        if (!g) continue;
        const t = resolveTarget(root, source, m[g]);
        if (!t) continue;
        if (!t.exists && !dest.has(t.rel)) {
          missing.add(m[g]);
          continue;
        }
        edits.push({ start: m.indices[g][0], end: m.indices[g][1], to: destFor(t.rel) });
      }
    }
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      lines[i] = lines[i].slice(0, e.start) + e.to + lines[i].slice(e.end);
    }
  }

  for (const [rel, to] of dest) {
    const from = abs(root, rel);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(abs(root, to))) fs.unlinkSync(from); // 內容相同的圖已經在 assets/
    else moveFile(from, abs(root, to));
    moved.push({ from: rel, to });
    pruneEmptyDirs(root, rel);
  }
  const text = lines.join('\n');
  if (text !== original) fs.writeFileSync(file, text);
  return { moved, missing: [...missing] };
}
