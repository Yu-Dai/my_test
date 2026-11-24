import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  configGet, configPath, configSet, configUnset, initKb, mountAdd, mountDisable, mountEnable, mountList, mountRemove,
  openUserConfig, resolveConfigPath, saveUserConfig, shareKb,
} from '../src/core/index.js';
import { loadConfig } from '../src/mcp/config.js';
import { CLI, SAMPLE_KB } from './helpers.js';

Object.assign(process.env, { GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-mount-'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 一份已存在的設定檔。 */
function setup(cfg = { knowledge_bases: [] }) {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { dir, file, where: { config: file, env: {} } };
}

function makeRepoKb(dir, name, confidentiality = 'internal') {
  const r = initKb(dir, { name, title: `${name} 知識庫`, description: '測試用', owner: 'tester', category: 'test', confidentiality });
  assert.equal(r.code, 0, r.text);
  return dir;
}

test('設定檔位置：指定路徑、環境變數、預設位置', () => {
  assert.deepEqual(resolveConfigPath('x.json', { LLM_WIKI_CONFIG: 'y.json' }), { file: path.resolve('x.json'), explicit: true });
  assert.deepEqual(resolveConfigPath(undefined, { LLM_WIKI_CONFIG: 'y.json' }), { file: path.resolve('y.json'), explicit: true });
  const d = resolveConfigPath(undefined, {});
  assert.equal(d.explicit, false);
  assert.equal(d.file, path.join(os.homedir(), '.llm-wiki', 'config.json'));
});

test('設定檔：預設位置不存在時建立，指定位置不存在時不建立', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'config.json');
  const created = openUserConfig({ file, explicit: false });
  assert.equal(created.ok && created.created, true);
  assert.deepEqual(readJson(file), { knowledge_bases: [] });
  assert.equal(openUserConfig({ file, explicit: false }).created, false);

  const missing = path.join(dir, 'nope.json');
  const r = mountList({ config: missing, env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /找不到設定檔[\s\S]*不會自動建立/);
  assert.equal(fs.existsSync(missing), false);
});

test('設定檔：讀不懂的檔案只回報，不覆寫', () => {
  const dir = tmp();
  const cases = { 'bad.json': '{ oops', 'array.json': '[]', 'list.json': '{"knowledge_bases": "x"}' };
  for (const [name, content] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const r = mountAdd({ config: file, env: {} }, SAMPLE_KB);
    assert.equal(r.code, 1, name);
    assert.match(r.text, /不會被覆寫/, name);
    assert.equal(fs.readFileSync(file, 'utf8'), content, name);
  }
});

test('設定檔：寫入保留未知欄位、處理 BOM、不留暫存檔', () => {
  const { dir, file, where } = setup();
  fs.writeFileSync(file, `﻿${JSON.stringify({ note: '自訂欄位', knowledge_bases: [] })}`);
  assert.equal(mountAdd(where, SAMPLE_KB).code, 0);
  assert.deepEqual(readJson(file), { note: '自訂欄位', knowledge_bases: [{ path: SAMPLE_KB }] });
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  assert.match(fs.readFileSync(file, 'utf8'), /\n$/);
});

test('設定檔：無法寫入時回報，不丟例外', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const r = saveUserConfig(path.join(blocker, 'config.json'), {});
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('mount add：本機知識庫，MCP 的設定讀取看得到', () => {
  const { file, where } = setup();
  const r = mountAdd(where, SAMPLE_KB);
  assert.equal(r.code, 0);
  assert.match(r.text, /已加入本機知識庫[\s\S]*代號 sample-uart[\s\S]*重新啟動 wiki MCP 後生效/);
  assert.deepEqual(loadConfig(['--config', file], {}).entries, [{ path: SAMPLE_KB }]);
  // 再加一次不重複
  assert.match(mountAdd(where, SAMPLE_KB).text, /已經在設定檔裡/);
  assert.equal(readJson(file).knowledge_bases.length, 1);
});

test('mount add：共享知識庫直接從儲存庫讀 kb.json', () => {
  const { dir, file, where } = setup();
  const kb = makeRepoKb(path.join(dir, 'kb'), 'shared-one');
  const remote = path.join(dir, 'share', 'shared-one.git');
  const shared = shareKb(kb, remote);
  assert.equal(shared.code, 0, shared.text);
  assert.match(shared.text, /kb mount add /);
  const r = mountAdd(where, remote);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /已加入共享知識庫[\s\S]*代號 shared-one/);
  assert.deepEqual(loadConfig(['--config', file], {}).entries, [{ remote }]);
});

test('mount add：各種不能加入的情況', () => {
  const { dir, file, where } = setup({ knowledge_bases: [{ path: SAMPLE_KB }] });
  const before = fs.readFileSync(file, 'utf8');
  assert.match(mountAdd(where, undefined).text, /沒有指定要加入的知識庫/);
  assert.match(mountAdd(where, path.join(dir, 'nope')).text, /找不到 /);
  fs.mkdirSync(path.join(dir, 'plain'));
  assert.match(mountAdd(where, path.join(dir, 'plain')).text, /不是知識庫資料夾（沒有 kb\.json），也不是共享儲存庫/);

  const broken = path.join(dir, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'kb.json'), '{ "name": "Bad Name" }');
  assert.match(mountAdd(where, broken).text, /kb\.json 不合格/);

  const twin = path.join(dir, 'twin');
  fs.cpSync(SAMPLE_KB, twin, { recursive: true });
  assert.match(mountAdd(where, twin).text, /代號「sample-uart」與已掛載的 .* 重複/);

  const secret = makeRepoKb(path.join(dir, 'secret'), 'secret-kb', 'confidential');
  const r = mountAdd(where, secret);
  assert.equal(r.code, 1);
  assert.match(r.text, /機密等級是 confidential，超過目前允許的 internal[\s\S]*kb config set max_confidentiality confidential --yes/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('mount list：空的設定、狀態與問題', () => {
  const empty = setup();
  assert.match(mountList(empty.where).text, /還沒有加入任何知識庫[\s\S]*kb mount add/);

  const { dir, where } = setup();
  const secret = makeRepoKb(path.join(dir, 'secret'), 'secret-kb', 'confidential');
  fs.writeFileSync(where.config, JSON.stringify({ knowledge_bases: [{ path: SAMPLE_KB }, 'gone', { path: 'secret' }, {}], disabled_knowledge_bases: [{ path: secret }] }));
  const out = mountList(where).text;
  assert.match(out, /可掛載的最高機密等級：internal/);
  assert.match(out, /已掛載（4）/);
  assert.match(out, /- sample-uart {2}本機 .*機密等級 public/);
  assert.match(out, /gone\n {4}\[有問題\] 找不到 kb\.json/);
  assert.match(out, /- secret-kb {2}本機 .*\n {4}\[有問題\] 機密等級 confidential 超過允許的 internal/);
  assert.match(out, /\[有問題\] 這一筆沒有 path 也沒有 remote/);
  assert.match(out, /已停用（1）：\n- secret-kb/);
});

test('mount remove／disable／enable', () => {
  const { dir, file, where } = setup({ knowledge_bases: [{ path: SAMPLE_KB }] });
  const other = makeRepoKb(path.join(dir, 'other'), 'other-kb');
  assert.equal(mountAdd(where, other).code, 0);

  assert.match(mountDisable(where, undefined).text, /沒有指定知識庫/);
  assert.match(mountDisable(where, 'nope').text, /設定檔裡沒有「nope」[\s\S]*kb mount list/);

  const off = mountDisable(where, 'other-kb');
  assert.equal(off.code, 0);
  assert.match(off.text, /已停用 other-kb[\s\S]*kb mount enable other-kb/);
  assert.deepEqual(readJson(file), { knowledge_bases: [{ path: SAMPLE_KB }], disabled_knowledge_bases: [{ path: other }] });
  // MCP 只讀 knowledge_bases，停用的不會被掛載
  assert.deepEqual(loadConfig(['--config', file], {}).entries, [{ path: SAMPLE_KB }]);
  assert.match(mountDisable(where, 'other-kb').text, /已經是停用狀態/);
  assert.match(mountAdd(where, other).text, /目前是停用狀態[\s\S]*kb mount enable other-kb/);

  // 用路徑也能指定
  assert.equal(mountEnable(where, other).code, 0);
  assert.equal(readJson(file).knowledge_bases.length, 2);
  assert.match(mountEnable(where, 'other-kb').text, /已經是啟用狀態/);

  const gone = mountRemove(where, 'sample-uart');
  assert.equal(gone.code, 0);
  assert.match(gone.text, /已從設定檔移除 sample-uart[\s\S]*檔案沒有變動/);
  assert.deepEqual(readJson(file).knowledge_bases, [{ path: other }]);
  assert.ok(fs.existsSync(path.join(SAMPLE_KB, 'kb.json')));
  // 停用中的也能移除
  mountDisable(where, 'other-kb');
  assert.equal(mountRemove(where, 'other-kb').code, 0);
  assert.deepEqual(readJson(file), { knowledge_bases: [], disabled_knowledge_bases: [] });
});

test('mount enable：重新啟用時一樣檢查代號重複，同名要用路徑指定', () => {
  const { dir, file, where } = setup();
  const twin = path.join(dir, 'twin');
  fs.cpSync(SAMPLE_KB, twin, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ knowledge_bases: [{ path: SAMPLE_KB }], disabled_knowledge_bases: [{ path: twin }] }));
  assert.match(mountEnable(where, twin).text, /代號「sample-uart」與已掛載的 .* 重複/);
  assert.match(mountRemove(where, 'sample-uart').text, /對應到 2 個知識庫[\s\S]*改用路徑指定/);
  assert.equal(mountRemove(where, twin).code, 0);
  assert.deepEqual(readJson(file), { knowledge_bases: [{ path: SAMPLE_KB }], disabled_knowledge_bases: [] });
});

test('config get／path', () => {
  const { dir, file, where } = setup();
  assert.equal(configPath(where).text, file);
  assert.match(configGet(where).text, /max_confidentiality = internal（預設值）\ncache_dir = .*（預設值）/);
  assert.match(configGet({ config: file, env: { LLM_WIKI_CACHE: path.join(dir, 'env-cache') } }, 'cache_dir').text, /env-cache（預設值）/);
  assert.match(configGet(where, 'nope').text, /沒有「nope」這個設定項目[\s\S]*max_confidentiality、cache_dir/);
});

test('config set max_confidentiality：調高要確認，調低列出受影響的知識庫', () => {
  const { dir, file, where } = setup();
  assert.match(configSet(where, 'max_confidentiality', 'secret').text, /必須是 public、internal、confidential 其中之一/);
  assert.match(configSet(where, 'max_confidentiality', undefined).text, /沒有給 max_confidentiality 的值/);

  const up = configSet(where, 'max_confidentiality', 'confidential');
  assert.equal(up.code, 1);
  assert.match(up.text, /需要使用者確認[\s\S]*--yes/);
  assert.deepEqual(readJson(file), { knowledge_bases: [] });
  assert.equal(configSet(where, 'max_confidentiality', 'confidential', { yes: true }).code, 0);
  assert.equal(loadConfig(['--config', file], {}).maxConfidentiality, 'confidential');

  const secret = makeRepoKb(path.join(dir, 'secret'), 'secret-kb', 'confidential');
  assert.equal(mountAdd(where, secret).code, 0);
  const down = configSet(where, 'max_confidentiality', 'public');
  assert.equal(down.code, 0);
  assert.match(down.text, /max_confidentiality = public[\s\S]*之後不會掛載：\n- secret-kb（confidential）/);

  // 回到預設值等於從 public 調高到 internal，一樣要確認
  assert.match(configUnset(where, 'max_confidentiality').text, /需要使用者確認/);
  assert.equal(configUnset(where, 'max_confidentiality', { yes: true }).code, 0);
  assert.equal('max_confidentiality' in readJson(file), false);
  assert.match(configUnset(where, 'max_confidentiality').text, /本來就是預設值/);
});

test('config set cache_dir：存絕對路徑，不能寫入時擋下', () => {
  const { dir, file, where } = setup();
  const cache = path.join(dir, 'my-cache');
  assert.equal(configSet(where, 'cache_dir', cache).code, 0);
  assert.ok(fs.statSync(cache).isDirectory());
  assert.equal(loadConfig(['--config', file], {}).cacheDir, cache);

  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const bad = configSet(where, 'cache_dir', path.join(blocker, 'cache'));
  assert.equal(bad.code, 1);
  assert.match(bad.text, /無法建立或無法寫入/);
  assert.equal(readJson(file).cache_dir, cache);

  assert.equal(configUnset(where, 'cache_dir').code, 0);
  assert.equal('cache_dir' in readJson(file), false);
});

test('CLI：第一次執行時在家目錄建立設定檔，之後沿用', () => {
  const home = tmp();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.LLM_WIKI_CONFIG;
  const kb = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  const file = path.join(home, '.llm-wiki', 'config.json');

  const first = kb('mount', 'add', SAMPLE_KB);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已建立設定檔：[\s\S]*已加入本機知識庫/);
  assert.deepEqual(readJson(file), { knowledge_bases: [{ path: SAMPLE_KB }] });

  const list = kb('mount', 'list');
  assert.doesNotMatch(list.stdout, /已建立設定檔/);
  assert.match(list.stdout, /已掛載（1）：\n- sample-uart/);

  const up = kb('config', 'set', 'max_confidentiality', 'confidential');
  assert.equal(up.status, 1);
  assert.match(up.stderr, /--yes/);
  assert.equal(kb('config', 'set', '--yes', 'max_confidentiality', 'confidential').status, 0);
  assert.equal(readJson(file).max_confidentiality, 'confidential');

  assert.equal(kb('mount').status, 2);
  assert.equal(kb('config', 'nope').status, 2);
  assert.equal(kb('mount', 'list', '--config', path.join(home, 'nope.json')).status, 1);
});
