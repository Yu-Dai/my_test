// 格式常數。標示「定死」的項目改動時必須提高 SCHEMA_VERSION 並附轉換腳本。

export const SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = [1];

// 定死：知識庫代號、分類、頁面名稱共用的規則（小寫英數加連字號）
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 暫定五種，新增類型不破壞舊頁面
export const PAGE_TYPES = ['summary', 'entity', 'concept', 'howto', 'comparison'];

// 定死：開頭欄位
export const FRONTMATTER_FIELDS = ['title', 'type', 'summary', 'keywords', 'aliases', 'sources', 'updated'];

// 定死：kb.json 欄位
export const KB_JSON_FIELDS = ['name', 'title', 'description', 'owner', 'category', 'schema_version', 'confidentiality'];

// 機密等級，由低到高。掛載時與使用者端設定的 max_confidentiality 比較
export const CONFIDENTIALITY_LEVELS = ['public', 'internal', 'confidential'];
export const DEFAULT_MAX_CONFIDENTIALITY = 'internal';

// 內文固定段落（二級標題），順序固定
export const BODY_SECTIONS = ['內容', '相關頁面', '來源'];

// raw/ 收任何文字檔，是不是文字由內容判斷（不是二進位、而且是 UTF-8），不看副檔名：
// 原始碼樹裡有很多沒有副檔名或後綴不固定的文字檔（Makefile、Kconfig.debug、foo.defconfig）。
// 這裡列的是要先轉成 markdown 的文件格式，直接擋下並提示轉檔，不靠內容判斷
export const CONVERT_FIRST_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'];
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

// 可調數值：實測後再定
export const LIMITS = {
  pageMaxChars: 12000, // 單頁內文長度上限，超過提示拆頁
  searchDefaultLimit: 10,
  searchMaxLimit: 30,
  snippetChars: 120,
  indexFlatMaxPages: 100, // 頁數超過就先回分類大綱
  indexMaxLines: 200, // GetWikiInfo 一次最多列幾頁
  readMaxChars: 30000, // ReadWiki 一次回傳的字數上限
  rawMaxLines: 300, // FetchRaw 一次回傳的行數上限
  rawMaxChars: 20000,
  rawHitsPerFile: 3, // 搜尋 raw 時每個檔案顯示幾個命中行
  grepHitsPerFile: 5, // grep 時每個頁面或檔案顯示幾個命中行
  grepMaxPatternChars: 200, // grep 樣式的長度上限
  grepMaxLineChars: 2000, // grep 時每一行只比對前面這麼多字
  sharedSyncIntervalMinutes: 30, // MCP 使用中，距離上次檢查共享知識庫超過這麼久就再更新一次
  grepTimeoutMs: 3000, // grep 比對的時間上限，超過就中止
  grepMaxContext: 50, // grep 最多可以連同命中行前後各幾行一起回傳
  grepAutoContext: 20, // 沒指定前後文、命中又少的時候，自動附上前後各幾行
  grepAutoContextMaxHits: 5, // 命中的行在這個數量以內才自動附前後文
  grepContextBudgetLines: 300, // 一次回傳的前後文總行數上限，超過的命中只列出那一行
  grepContextLineChars: 200, // grep 顯示前後文時每一行的長度上限
  grepScopeScanLines: 1000, // 找命中行所在的函式時，最多往上看幾行
  ingestPartLines: 300, // ingest 時來源一段幾行
  ingestRelatedPages: 8, // ingest 時列出幾個可能相關的既有頁面
  imageMaxBytes: 1024 * 1024, // 單張圖片大小上限
  updateMaxChangeRatio: 0.5, // 來源更新時，變動的行數超過這個比例就整份重做
  updateDiffMaxLines: 400, // 來源更新時，差異超過這麼多行就整份重做
};
