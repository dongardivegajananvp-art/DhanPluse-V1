import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const html = fs.readFileSync('site/index.html', 'utf8');
const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gv2vpd-inline-js-'));
let checked = 0;
try {
  for (const match of matches) {
    const attributes = match[1] || '';
    const source = match[2] || '';
    if (/\bsrc\s*=|application\/(?:ld\+)?json/i.test(attributes) || !source.trim()) continue;
    const file = path.join(directory, 'inline-' + (checked + 1) + '.mjs');
    fs.writeFileSync(file, source);
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    checked += 1;
  }
  if (!checked) throw new Error('No inline JavaScript blocks were found in site/index.html.');
  console.log('PASS: syntax-checked ' + checked + ' inline JavaScript block(s) in site/index.html.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
