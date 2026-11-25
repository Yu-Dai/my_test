// grepSearch 啟動的子行程：從 stdin 讀工作內容，把結果寫到 stdout。獨立成行程是為了能在逾時的時候中止。

import fs from 'node:fs';
import { grepLines } from './grep.js';

const { sources, pattern, opts } = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(grepLines(sources, pattern, opts)));
