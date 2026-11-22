// 輕量 markdown 掃描：只認程式碼區塊、標題、連結、圖片。不做完整解析。

/** 回傳每一行是否位於 ``` 或 ~~~ 區塊內（含圍欄行本身）。 */
export function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fence = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s*$/.test(lines[i].slice(m[0].length))) {
        fence = null;
      }
    } else if (m) {
      mask[i] = true;
      fence = { ch: m[1][0], len: m[1].length };
    }
  }
  return mask;
}

/**
 * 列出標題。
 * @param {string[]} lines
 * @param {number} lineOffset lines[0] 在檔案中的行號（從 1 起算）
 * @returns {{ level: number, text: string, line: number }[]}
 */
export function listHeadings(lines, lineOffset = 1) {
  const mask = fenceMask(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + lineOffset });
  }
  return out;
}

function blankInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
}

/**
 * 抽出 wiki 連結與 markdown 連結／圖片，略過程式碼。
 * @returns {{ wikiLinks: { inner: string, line: number }[], mdLinks: { image: boolean, text: string, target: string, line: number }[] }}
 */
export function extractLinks(lines, lineOffset = 1) {
  const mask = fenceMask(lines);
  const wikiLinks = [];
  const mdLinks = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = blankInlineCode(lines[i]);
    for (const m of line.matchAll(/\[\[([^\[\]\n]*)\]\]/g)) {
      wikiLinks.push({ inner: m[1], line: i + lineOffset });
    }
    for (const m of line.matchAll(/(!?)\[([^\[\]\n]*)\]\(\s*([^()\s]*)(?:\s+"[^"]*")?\s*\)/g)) {
      mdLinks.push({ image: m[1] === '!', text: m[2].trim(), target: m[3], line: i + lineOffset });
    }
  }
  return { wikiLinks, mdLinks };
}
