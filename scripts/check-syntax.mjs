#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(filename);
  }
}
for (const directory of ['src', 'extension', 'scripts', 'test']) {
  if (fs.existsSync(path.join(root, directory))) walk(path.join(root, directory));
}
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${path.relative(root, filename)}\n`);
    process.exit(1);
  }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
