import { staleIndexes } from './indexgen.js';
import { loadKb } from './kb.js';

/** 整庫檢查：格式、連結、來源引用、索引是否過期。 */
export function checkKb(root) {
  const kb = loadKb(root);
  const issues = [...kb.issues];
  if (kb.meta && !issues.some((i) => i.level === 'error')) {
    for (const rel of staleIndexes(kb)) {
      issues.push({ level: 'error', code: 'index-stale', file: rel, line: null, message: `${rel} 與目前的頁面不一致（不存在或已過期）`, example: null, next: '執行：kb rebuild' });
    }
  }
  return { kb, issues };
}

/** 固定格式：哪裡不合格、正確寫法、下一步。 */
export function formatIssue(issue) {
  const tag = issue.level === 'error' ? '錯誤' : '警告';
  const where = issue.line ? `${issue.file} 第 ${issue.line} 行` : issue.file;
  const out = [`[${tag}] ${where}：${issue.message}`];
  if (issue.example) out.push(`  正確寫法：${String(issue.example).split('\n').join('\n    ')}`);
  if (issue.next) out.push(`  下一步：${issue.next}`);
  return out.join('\n');
}

export function formatReport(issues, okMessage) {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  if (issues.length === 0) return okMessage;
  const out = issues.map(formatIssue);
  out.push('', errors.length ? `結果：不合格，${errors.length} 個錯誤、${warns.length} 個警告。請依每一項的「下一步」處理。` : `結果：合格，但有 ${warns.length} 個警告。`);
  return out.join('\n');
}
