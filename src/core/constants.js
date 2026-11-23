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

// raw/ 允許的副檔名
export const RAW_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.log',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.py', '.js', '.ts', '.java', '.go', '.rs', '.sh', '.bat', '.ps1',
  '.html', '.htm', '.xml', '.json', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.toml',
  '.csv', '.tsv', '.s', '.asm', '.ld', '.dts', '.dtsi', '.mk', '.cmake', '.sql',
];
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
  ingestPartLines: 300, // ingest 時來源一段幾行
  ingestRelatedPages: 8, // ingest 時列出幾個可能相關的既有頁面
  imageMaxBytes: 1024 * 1024, // 單張圖片大小上限
};
