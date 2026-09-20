#!/usr/bin/env node

//

//
//   node scripts/pack-extension.mjs            → dist/beat-browser-<version>.zip
//

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, 'dist', `beat-browser-${manifest.version}.zip`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-pack-'));
fs.cpSync(SRC, stage, { recursive: true, filter: (p) => !/\.DS_Store$|\/content\/?$/.test(p) });
const { key, ...clean } = manifest;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(clean, null, 2) + '\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
try { fs.unlinkSync(out); } catch {  }
execFileSync('zip', ['-qr', out, '.'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

console.log(`${out}  (${Math.round(fs.statSync(out).size / 1024)}KB)`);
console.log(`Removed manifest.key${key ? "" : " (absent)"}; version ${manifest.version}.`);
console.log('The next steps are done by a person: https://chrome.google.com/webstore/devconsole → Upload this zip → Fill in the privacy statement (PRIVACY.md) → Submit for review.');
