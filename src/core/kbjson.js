import { CONFIDENTIALITY_LEVELS, KB_JSON_FIELDS, SCHEMA_VERSION, SLUG_RE, SUPPORTED_SCHEMA_VERSIONS } from './constants.js';

export const KB_JSON_EXAMPLE = JSON.stringify(
  {
    name: 'uart-driver',
    title: 'UART 驅動程式知識庫',
    description: '示範板 UART 控制器的規格、驅動程式與除錯方法',
    owner: 'firmware-team',
    category: 'driver',
    schema_version: SCHEMA_VERSION,
    confidentiality: 'public',
  },
  null,
  2,
);

/**
 * 驗證 kb.json 內容。
 * @param {string} text 檔案內容
 * @returns {{ meta: object|null, issues: object[] }}
 */
export function validateKbJson(text) {
  const issues = [];
  const next = '修正 kb.json 後執行：kb check';
  const err = (code, message, example) => issues.push({ level: 'error', code, file: 'kb.json', line: null, message, example, next });

  let meta;
  try {
    meta = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    err('kbjson-parse', `kb.json 不是合法的 JSON：${e.message}`, KB_JSON_EXAMPLE);
    return { meta: null, issues };
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    err('kbjson-parse', 'kb.json 必須是一個物件', KB_JSON_EXAMPLE);
    return { meta: null, issues };
  }

  for (const key of Object.keys(meta)) {
    if (!KB_JSON_FIELDS.includes(key)) err('kbjson-unknown', `kb.json 有未知的欄位「${key}」`, `只能有這些欄位：${KB_JSON_FIELDS.join('、')}`);
  }
  if (typeof meta.name !== 'string' || !SLUG_RE.test(meta.name)) {
    err('kbjson-name', 'name 必須是小寫英數加連字號', '"name": "uart-driver"');
  }
  for (const key of ['title', 'description', 'owner']) {
    if (typeof meta[key] !== 'string' || !meta[key].trim()) err(`kbjson-${key}`, `${key} 必填，且必須是文字`, `"${key}": "..."`);
  }
  if (!CONFIDENTIALITY_LEVELS.includes(meta.confidentiality)) {
    err('kbjson-confidentiality', `confidentiality 必須是 ${CONFIDENTIALITY_LEVELS.join('、')} 其中之一（由低到高）`, '"confidentiality": "internal"');
  }
  if (typeof meta.category !== 'string' || !SLUG_RE.test(meta.category)) {
    err('kbjson-category', 'category 必須是小寫英數加連字號', '"category": "driver"');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(meta.schema_version)) {
    err('kbjson-schema-version', `schema_version 不支援（目前支援：${SUPPORTED_SCHEMA_VERSIONS.join('、')}）`, `"schema_version": ${SCHEMA_VERSION}`);
  }
  return { meta, issues };
}
