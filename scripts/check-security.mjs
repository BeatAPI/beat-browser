#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A repeatable, narrow source gate, not a claim of a comprehensive security audit.
// Test credentials are deliberately synthetic and constructed at runtime.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];
let checked = 0;
const rules = [
  ['private-key-material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}/g],
  ['credential-shaped-literal', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b/g],
];
function scan(filename) {
  if (!/\.(?:js|mjs|md|json|html)$/.test(filename)) return;
  const text = fs.readFileSync(filename, 'utf8');
  checked++;
  for (const [rule, regex] of rules) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text))) {
      // Never print the matched value in diagnostics.
      findings.push({ file: path.relative(root, filename), line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  if (filename.startsWith(path.join(root, 'extension') + path.sep)
    && /BEATAPI_API_KEY|api\.beatapi\.io\/v1\/(?:systemone|chat)/.test(text)) {
    findings.push({ file: path.relative(root, filename), rule: 'cloud-credential-boundary-in-extension' });
  }
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) findings.push({ file: path.relative(root, filename), rule: 'unexpected-symlink' });
    else if (entry.isDirectory()) walk(filename);
    else scan(filename);
  }
}
for (const directory of ['src', 'extension', 'test', 'docs', 'scripts']) {
  if (fs.existsSync(path.join(root, directory))) walk(path.join(root, directory));
}
for (const filename of ['README.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'HANDOFF.md', 'TEST_RESULTS.md', 'package.json', 'package-lock.json']) {
  if (fs.existsSync(path.join(root, filename))) scan(path.join(root, filename));
}
console.log(JSON.stringify({ checkedFiles: checked, findings, scope: 'Source patterns and extension cloud boundary; not exhaustive secret detection.' }, null, 2));
process.exitCode = findings.length ? 1 : 0;
