#!/usr/bin/env node
// wiki MCP server：本機 stdio，唯讀，五個工具。stdout 留給協定，訊息一律寫 stderr。

import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Mounts } from './mounts.js';
import { SERVER_INSTRUCTIONS, fetchImage, fetchRaw, getWikiInfo, readWiki, searchWikiTool } from './tools.js';

const strOrList = z.union([z.array(z.string()), z.string()]);
const intLike = z.union([z.number(), z.string()]).optional();

const TOOLS = [
  {
    name: 'GetWikiInfo',
    fn: getWikiInfo,
    description: '列出知識庫與頁面目錄。不帶參數：列出所有已掛載的知識庫（代號、分類、描述、頁數）。帶 kb：列出該知識庫的頁面目錄；頁面很多時先回分類大綱，再帶 category 取該分類的頁面。查資料時先呼叫這個工具。',
    inputSchema: {
      kb: z.string().optional().describe('知識庫代號，例如 "uart-driver"。省略則列出所有知識庫'),
      category: z.string().optional().describe('有帶 kb 時：頁面分類，例如 "uart"。沒帶 kb 時：只列出這個分類的知識庫'),
      offset: intLike.describe('略過前幾筆，回傳內容說「還有 N 頁沒列出」時才需要'),
    },
  },
  {
    name: 'SearchWiki',
    fn: searchWikiTool,
    description: '搜尋知識庫，兩種方式擇一。（1）terms：關鍵字搜尋，多個關鍵字任一命中即算，不分大小寫，不是語意搜尋；中文、英文、縮寫都放進去命中率較高；回傳頁面代號、摘要、命中片段。（2）pattern：樣式比對（regex，像 grep），逐行比對並列出命中的行、行數、所在的函式或章節，適合找函式名、暫存器位址、錯誤碼這類有固定格式的東西；找程式碼時加 scope="raw"。',
    inputSchema: {
      terms: strOrList.optional().describe('關鍵字陣列，例如 ["鮑率", "baud rate", "BRR"]。與 pattern 擇一'),
      pattern: z.string().optional().describe('regex 樣式，逐行比對、不分大小寫，例如 "uart_\\w+_init" 或 "0x[0-9A-F]{4}"。與 terms 擇一'),
      kb: z.string().optional().describe('知識庫代號。省略則搜尋所有知識庫'),
      scope: z.string().optional().describe('"wiki"（預設，搜尋整理過的頁面）或 "raw"（搜尋原始來源檔：頁面找不到時，或用 pattern 找程式碼時）'),
      context: intLike.describe('只用於 pattern：連同命中行前後各幾行一起回傳，0 到 5，預設 0。命中的行太像、分不出差別時設為 3'),
      limit: intLike.describe('最多回傳幾筆，預設 10'),
      offset: intLike.describe('略過前幾筆，回傳內容說「還有 N 筆」時才需要'),
    },
  },
  {
    name: 'ReadWiki',
    fn: readWiki,
    description: '讀取一個或多個頁面的全文。頁面代號是「分類/名稱」，從 GetWikiInfo 或 SearchWiki 的結果取得。回傳內容附該頁連到的其他頁面與來源清單。',
    inputSchema: {
      kb: z.string().optional().describe('知識庫代號。只掛載一個知識庫時可省略'),
      pages: strOrList.describe('頁面代號陣列，例如 ["uart/baud-rate", "guide/init-uart"]'),
    },
  },
  {
    name: 'FetchRaw',
    fn: fetchRaw,
    description: '讀取原始來源檔的指定部分。頁面內容不夠細、需要看原文或程式碼時使用。path 直接填頁面「來源」列出的寫法（raw/spec.md#3.2 或 raw/drv.c:L120-L180）即可；只給檔名時，小檔案回傳全文，大檔案回傳章節大綱。',
    inputSchema: {
      kb: z.string().optional().describe('知識庫代號。只掛載一個知識庫時可省略'),
      path: z.string().describe('來源檔路徑，以 raw/ 開頭，可帶位置：raw/spec.md#3.2 或 raw/drv.c:L120-L180'),
      section: z.string().optional().describe('章節編號或標題（只用於 markdown 來源），例如 "3.2"'),
      start_line: intLike.describe('起始行數'),
      end_line: intLike.describe('結束行數'),
    },
  },
  {
    name: 'FetchImage',
    fn: fetchImage,
    description: '讀取頁面裡的一張圖片。頁面的文字說明不夠、需要看圖（時序圖、電路圖、表格截圖）才能回答時使用。path 直接填 ReadWiki 回傳的「本頁的圖片」列出的寫法（kb://知識庫代號/assets/檔名）即可。一次讀一張。',
    inputSchema: {
      kb: z.string().optional().describe('知識庫代號。path 是 kb:// 開頭，或只掛載一個知識庫時可省略'),
      path: z.string().describe('圖片路徑：kb://uart-driver/assets/uart-frame.png 或 assets/uart-frame.png'),
    },
  },
];

const config = loadConfig(process.argv.slice(2));
// 先用既有的本機快取掛載，馬上可以用；共享知識庫的更新在連線後於背景進行
const mounts = new Mounts(config.entries, config.problems, { maxConfidentiality: config.maxConfidentiality, cacheDir: config.cacheDir });
const report = () => {
  for (const p of mounts.problems) console.error(`[wiki-mcp] ${p}`);
  console.error(`[wiki-mcp] 已掛載 ${mounts.names().length} 個知識庫：${mounts.names().join('、') || '（無）'}`);
};
report();

const server = new McpServer({ name: 'wiki', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
    async (args) => {
      try {
        const out = tool.fn(mounts, args);
        if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
        return { content: [{ type: 'text', text: out.text }, { type: 'image', data: out.image.data, mimeType: out.image.mimeType }] };
      } catch (e) {
        console.error(`[wiki-mcp] ${tool.name} 失敗：${e.stack ?? e}`);
        return { content: [{ type: 'text', text: `${tool.name} 執行時發生內部錯誤：${e.message}\n下一步：換一種參數再試；持續發生時請回報給知識庫維護者。` }], isError: true };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
if (mounts.entries.some((e) => e.remote)) {
  mounts.syncAll().then(report, (e) => console.error(`[wiki-mcp] 更新共享知識庫時發生錯誤：${e.stack ?? e}`));
}
