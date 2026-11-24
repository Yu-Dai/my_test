// kb mount／kb config：用指令維護使用者端的掛載設定檔，使用者不必手動編輯 JSON。
// 只寫設定檔，不碰知識庫內容。wiki MCP 在啟動時讀取設定檔，所以變更要重新啟動 MCP 才生效。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIDENTIALITY_LEVELS, DEFAULT_MAX_CONFIDENTIALITY } from './constants.js';
import { git } from './git.js';
import { validateKbJson } from './kbjson.js';
import { isBareRepo } from './remote.js';
import {
  KEY_CACHE_DIR, KEY_DISABLED, KEY_MAX_CONFIDENTIALITY, KEY_MOUNTS, defaultCacheDir, openUserConfig, resolveConfigPath, saveUserConfig,
} from './userconfig.js';

const KIND_LOCAL = 'path';
const KIND_SHARED = 'remote';
const KIND_LABEL = { [KIND_LOCAL]: '本機', [KIND_SHARED]: '共享' };
const SETTABLE_KEYS = [KEY_MAX_CONFIDENTIALITY, KEY_CACHE_DIR];
const RESTART_NOTE = '重新啟動 wiki MCP 後生效。';
const FILE_URL_PREFIX = 'file://';

const fail = (message, next) => ({ code: 1, text: `[錯誤] ${message}${next ? `\n  下一步：${next}` : ''}` });
const lastLine = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const isUrl = (s) => s.includes('://');
const levelOf = (c) => CONFIDENTIALITY_LEVELS.indexOf(c);
const nameOf = (e) => (e.meta?.name ? `${e.meta.name}（${e.target}）` : e.target);
const maxOf = (cfg) => (CONFIDENTIALITY_LEVELS.includes(cfg[KEY_MAX_CONFIDENTIALITY]) ? cfg[KEY_MAX_CONFIDENTIALITY] : DEFAULT_MAX_CONFIDENTIALITY);

/**
 * 開啟設定檔並執行一個動作。
 * @param {{ config?: string, env?: NodeJS.ProcessEnv }} where 設定檔位置的來源
 * @param {(ctx: { file: string, base: string, cfg: object, env: NodeJS.ProcessEnv }) => { code: number, text: string }} action
 */
function withConfig(where, action) {
  const env = where.env ?? process.env;
  const at = resolveConfigPath(where.config, env);
  const opened = openUserConfig(at);
  if (!opened.ok) return fail(opened.message, opened.next);
  const r = action({ file: at.file, base: path.dirname(at.file), cfg: opened.cfg, env });
  return opened.created ? { code: r.code, text: `已建立設定檔：${at.file}\n${r.text}` } : r;
}

function save(ctx, text) {
  const w = saveUserConfig(ctx.file, ctx.cfg);
  return w.ok ? { code: 0, text } : fail(`無法寫入設定檔 ${ctx.file}：${w.error}`, '確認這個檔案與所在資料夾可以寫入');
}

/** 設定檔的一筆知識庫 → { item, kind, target }。相對路徑以設定檔所在的資料夾為準。 */
function parseItem(item, base) {
  const local = typeof item === 'string' ? item : item?.path;
  const remote = item !== null && typeof item === 'object' ? item.remote : null;
  if (typeof remote === 'string' && remote.trim()) return { item, kind: KIND_SHARED, target: isUrl(remote) ? remote.trim() : path.resolve(base, remote.trim()) };
  if (typeof local === 'string' && local.trim()) return { item, kind: KIND_LOCAL, target: path.resolve(base, local.trim()) };
  return { item, kind: null, target: JSON.stringify(item) };
}

/**
 * 讀出知識庫的 kb.json。共享知識庫直接從儲存庫讀，不需要先下載。
 * @returns {{ meta: object|null, problem: string|null }} 無法檢查內容的遠端網址回傳 meta 與 problem 都是 null
 */
function inspect(kind, target) {
  let text;
  if (kind === KIND_LOCAL) {
    try {
      text = fs.readFileSync(path.join(target, 'kb.json'), 'utf8');
    } catch {
      return { meta: null, problem: '找不到 kb.json（路徑錯誤，或這不是知識庫）' };
    }
  } else if (kind === KIND_SHARED) {
    if (isUrl(target) && !target.startsWith(FILE_URL_PREFIX)) {
      const r = git(process.cwd(), ['ls-remote', '--quiet', target, 'HEAD']);
      return { meta: null, problem: r.ok ? null : `連不上這個位置（${lastLine(r.stderr)}）` };
    }
    let dir = target;
    if (isUrl(target)) {
      try {
        dir = fileURLToPath(target);
      } catch {
        return { meta: null, problem: '網址格式不正確' };
      }
    }
    if (!fs.existsSync(dir)) return { meta: null, problem: '找不到這個路徑（共享資料夾連不上，或路徑錯誤）' };
    if (!isBareRepo(dir)) return { meta: null, problem: '不是共享儲存庫' };
    const r = git(dir, ['show', 'HEAD:kb.json']);
    if (!r.ok) return { meta: null, problem: `讀不到儲存庫裡的 kb.json（${lastLine(r.stderr)}）` };
    text = r.stdout;
  } else {
    return { meta: null, problem: '這一筆沒有 path 也沒有 remote' };
  }
  const { meta, issues } = validateKbJson(text);
  const errors = issues.filter((i) => i.level === 'error');
  return errors.length ? { meta: null, problem: `kb.json 不合格（${errors.map((i) => i.message).join('；')}）` } : { meta, problem: null };
}

function entries(ctx, key) {
  return (ctx.cfg[key] ?? []).map((item) => {
    const e = parseItem(item, ctx.base);
    return { ...e, key, ...inspect(e.kind, e.target) };
  });
}

/** 用知識庫代號或路徑找出設定檔裡的知識庫。 */
function find(list, ref) {
  const byPath = list.filter((e) => e.target === ref || (e.kind && !isUrl(e.target) && e.target === path.resolve(ref)));
  return byPath.length ? byPath : list.filter((e) => e.meta?.name === ref);
}

/** 這個知識庫能不能掛載：代號不可與已掛載的重複，機密等級不可超過上限。能掛載回傳 null。 */
function refusal(ctx, meta, label) {
  if (!meta) return null;
  const same = entries(ctx, KEY_MOUNTS).find((e) => e.meta?.name === meta.name);
  if (same) return fail(`知識庫代號「${meta.name}」與已掛載的 ${same.target} 重複`, `兩個知識庫不能同名。先移除另一個：kb mount remove ${same.target}`);
  const max = maxOf(ctx.cfg);
  if (levelOf(meta.confidentiality) > levelOf(max)) {
    return fail(
      `${label} 的機密等級是 ${meta.confidentiality}，超過目前允許的 ${max}`,
      `確定這個環境可以使用該等級的資料時，由使用者執行：kb config set ${KEY_MAX_CONFIDENTIALITY} ${meta.confidentiality} --yes，再重新加入`,
    );
  }
  return null;
}

function describe(e, max, names) {
  const head = `- ${e.meta?.name ?? '（代號不明）'}  ${KIND_LABEL[e.kind] ?? '無效'}  ${e.target}`;
  if (e.problem) return `${head}\n    [有問題] ${e.problem}`;
  if (!e.meta) return `${head}\n    內容要等 wiki MCP 下載後才能檢查`;
  if (e.key === KEY_MOUNTS && levelOf(e.meta.confidentiality) > levelOf(max)) {
    return `${head}\n    [有問題] 機密等級 ${e.meta.confidentiality} 超過允許的 ${max}，不會掛載`;
  }
  if (e.key === KEY_MOUNTS && names.filter((n) => n === e.meta.name).length > 1) return `${head}\n    [有問題] 代號重複，只有第一個會掛載`;
  return `${head}  （${e.meta.title}，機密等級 ${e.meta.confidentiality}）`;
}

export function mountList(where) {
  return withConfig(where, (ctx) => {
    const max = maxOf(ctx.cfg);
    const active = entries(ctx, KEY_MOUNTS);
    const disabled = entries(ctx, KEY_DISABLED);
    const out = [`設定檔：${ctx.file}`, `可掛載的最高機密等級：${max}`, ''];
    if (active.length + disabled.length === 0) {
      out.push('還沒有加入任何知識庫。', '  下一步：kb mount add <知識庫資料夾>，或 kb mount add <共享資料夾>/<代號>.git');
      return { code: 0, text: out.join('\n') };
    }
    const names = active.map((e) => e.meta?.name);
    out.push(`已掛載（${active.length}）：`, ...active.map((e) => describe(e, max, names)));
    if (disabled.length) out.push('', `已停用（${disabled.length}）：`, ...disabled.map((e) => describe(e, max, names)));
    return { code: 0, text: out.join('\n') };
  });
}

export function mountAdd(where, targetArg) {
  return withConfig(where, (ctx) => {
    const usage = 'kb mount add <知識庫資料夾>，或 kb mount add <共享資料夾>/<代號>.git';
    if (!targetArg) return fail('沒有指定要加入的知識庫', usage);
    let kind = KIND_SHARED;
    let target = targetArg.trim();
    if (!isUrl(target)) {
      target = path.resolve(target);
      if (!fs.existsSync(target)) return fail(`找不到 ${target}`, '確認路徑是否正確；共享資料夾要先連得上');
      if (fs.existsSync(path.join(target, 'kb.json'))) kind = KIND_LOCAL;
      else if (!isBareRepo(target)) return fail(`${target} 不是知識庫資料夾（沒有 kb.json），也不是共享儲存庫`, usage);
    }
    const label = `${KIND_LABEL[kind]}知識庫 ${target}`;
    const { meta, problem } = inspect(kind, target);
    if (problem) return fail(`${label} 無法加入：${problem}`, '請知識庫維護者確認這個位置的內容');

    if (entries(ctx, KEY_MOUNTS).some((e) => e.target === target)) return { code: 0, text: `${label} 已經在設定檔裡，沒有變更。` };
    if (entries(ctx, KEY_DISABLED).some((e) => e.target === target)) return fail(`${label} 已經加入，目前是停用狀態`, `重新啟用：kb mount enable ${meta?.name ?? target}`);
    const refused = refusal(ctx, meta, label);
    if (refused) return refused;

    ctx.cfg[KEY_MOUNTS] = [...(ctx.cfg[KEY_MOUNTS] ?? []), { [kind]: target }];
    return save(ctx, `已加入${label}${meta ? `（代號 ${meta.name}）` : ''}。\n${RESTART_NOTE}`);
  });
}

/** 找出唯一的一筆。找不到或有多筆時回傳錯誤。 */
function pick(list, ref, usage) {
  if (!ref) return { error: fail('沒有指定知識庫', usage) };
  const hits = find(list, ref);
  if (hits.length === 0) return { error: fail(`設定檔裡沒有「${ref}」`, '看目前有哪些知識庫：kb mount list') };
  if (hits.length > 1) return { error: fail(`「${ref}」對應到 ${hits.length} 個知識庫`, `改用路徑指定：\n${hits.map((e) => `    ${e.target}`).join('\n')}`) };
  return { entry: hits[0] };
}

const without = (ctx, entry) => {
  ctx.cfg[entry.key] = ctx.cfg[entry.key].filter((item) => item !== entry.item);
};

export function mountRemove(where, ref) {
  return withConfig(where, (ctx) => {
    const { entry, error } = pick([...entries(ctx, KEY_MOUNTS), ...entries(ctx, KEY_DISABLED)], ref, 'kb mount remove <代號或路徑>');
    if (error) return error;
    without(ctx, entry);
    return save(ctx, `已從設定檔移除 ${nameOf(entry)}。知識庫本身的檔案沒有變動。\n${RESTART_NOTE}`);
  });
}

export function mountDisable(where, ref) {
  return withConfig(where, (ctx) => {
    if (ref && find(entries(ctx, KEY_MOUNTS), ref).length === 0 && find(entries(ctx, KEY_DISABLED), ref).length === 1) {
      return { code: 0, text: `「${ref}」已經是停用狀態，沒有變更。` };
    }
    const { entry, error } = pick(entries(ctx, KEY_MOUNTS), ref, 'kb mount disable <代號或路徑>');
    if (error) return error;
    without(ctx, entry);
    ctx.cfg[KEY_DISABLED] = [...(ctx.cfg[KEY_DISABLED] ?? []), entry.item];
    return save(ctx, `已停用 ${entry.meta?.name ?? entry.target}，設定仍保留。重新啟用：kb mount enable ${entry.meta?.name ?? entry.target}\n${RESTART_NOTE}`);
  });
}

export function mountEnable(where, ref) {
  return withConfig(where, (ctx) => {
    if (ref && find(entries(ctx, KEY_DISABLED), ref).length === 0 && find(entries(ctx, KEY_MOUNTS), ref).length === 1) {
      return { code: 0, text: `「${ref}」已經是啟用狀態，沒有變更。` };
    }
    const { entry, error } = pick(entries(ctx, KEY_DISABLED), ref, 'kb mount enable <代號或路徑>');
    if (error) return error;
    const refused = refusal(ctx, entry.meta, `${KIND_LABEL[entry.kind] ?? ''}知識庫 ${entry.target}`);
    if (refused) return refused;
    without(ctx, entry);
    ctx.cfg[KEY_MOUNTS] = [...(ctx.cfg[KEY_MOUNTS] ?? []), entry.item];
    return save(ctx, `已啟用 ${entry.meta?.name ?? entry.target}。\n${RESTART_NOTE}`);
  });
}

function shown(ctx, key) {
  if (key === KEY_MAX_CONFIDENTIALITY) return `${key} = ${maxOf(ctx.cfg)}${ctx.cfg[key] === undefined ? '（預設值）' : ''}`;
  const set = typeof ctx.cfg[key] === 'string' && ctx.cfg[key].trim();
  return `${key} = ${set ? path.resolve(ctx.base, ctx.cfg[key].trim()) : `${defaultCacheDir(ctx.env)}（預設值）`}`;
}

const unknownKey = (key) => fail(key ? `沒有「${key}」這個設定項目` : '沒有指定設定項目', `可用的項目：${SETTABLE_KEYS.join('、')}`);

export function configPath(where) {
  return withConfig(where, (ctx) => ({ code: 0, text: ctx.file }));
}

export function configGet(where, key) {
  return withConfig(where, (ctx) => {
    if (key && !SETTABLE_KEYS.includes(key)) return unknownKey(key);
    return { code: 0, text: (key ? [key] : SETTABLE_KEYS).map((k) => shown(ctx, k)).join('\n') };
  });
}

export function configSet(where, key, value, { yes = false } = {}) {
  return withConfig(where, (ctx) => {
    if (!SETTABLE_KEYS.includes(key)) return unknownKey(key);
    if (typeof value !== 'string' || !value.trim()) return fail(`沒有給 ${key} 的值`, `kb config set ${key} <值>；要回到預設值：kb config unset ${key}`);

    if (key === KEY_CACHE_DIR) {
      const dir = path.resolve(value.trim());
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (e) {
        return fail(`快取資料夾 ${dir} 無法建立或無法寫入：${e.message}`, '換一個可以寫入的本機資料夾');
      }
      ctx.cfg[key] = dir;
      return save(ctx, `${shown(ctx, key)}\n原本快取資料夾裡的內容不會搬移，共享知識庫會在新位置重新下載。\n${RESTART_NOTE}`);
    }

    const level = value.trim();
    if (!CONFIDENTIALITY_LEVELS.includes(level)) return fail(`${key} 必須是 ${CONFIDENTIALITY_LEVELS.join('、')} 其中之一（由低到高）`, `kb config set ${key} ${DEFAULT_MAX_CONFIDENTIALITY}`);
    if (levelOf(level) > levelOf(maxOf(ctx.cfg)) && !yes) {
      return fail(
        `要把可掛載的最高機密等級從 ${maxOf(ctx.cfg)} 調高到 ${level}，需要使用者確認`,
        `這會讓 AI agent 讀得到 ${level} 等級的知識庫。由使用者確定這個環境可以使用該等級的資料後執行：kb config set ${key} ${level} --yes`,
      );
    }
    ctx.cfg[key] = level;
    const blocked = entries(ctx, KEY_MOUNTS).filter((e) => e.meta && levelOf(e.meta.confidentiality) > levelOf(level));
    const note = blocked.length ? `\n注意：以下知識庫的機密等級超過 ${level}，之後不會掛載：\n${blocked.map((e) => `- ${e.meta.name}（${e.meta.confidentiality}）`).join('\n')}` : '';
    return save(ctx, `${shown(ctx, key)}${note}\n${RESTART_NOTE}`);
  });
}

export function configUnset(where, key, { yes = false } = {}) {
  return withConfig(where, (ctx) => {
    if (!SETTABLE_KEYS.includes(key)) return unknownKey(key);
    if (ctx.cfg[key] === undefined) return { code: 0, text: `${shown(ctx, key)}\n本來就是預設值，沒有變更。` };
    if (key === KEY_MAX_CONFIDENTIALITY && levelOf(DEFAULT_MAX_CONFIDENTIALITY) > levelOf(maxOf(ctx.cfg)) && !yes) {
      return fail(`回到預設值會把可掛載的最高機密等級從 ${maxOf(ctx.cfg)} 調高到 ${DEFAULT_MAX_CONFIDENTIALITY}，需要使用者確認`, `由使用者確認後執行：kb config unset ${key} --yes`);
    }
    delete ctx.cfg[key];
    return save(ctx, `${shown(ctx, key)}\n${RESTART_NOTE}`);
  });
}
