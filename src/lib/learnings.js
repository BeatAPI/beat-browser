

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';
import { VERSION } from './version.js';
import { validateScript } from '../../extension/script.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'learnings');

export const LEARNINGS_DIR = process.env.BEAT_BROWSER_LEARNINGS_DIR || path.join(HOME, 'learnings');

const ALIAS = {
  'tmall.com': 'taobao.com',
  'twitter.com': 'x.com',
  'larksuite.com': 'feishu.cn',
  'qpic.cn': 'weixin.qq.com',
  'weibo.com': 'weibo.cn',
};

// 'https://my.feishu.cn/base/x?y=1' → 'my.feishu.cn'
function normalize(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split(':')[0];
  return d.replace(/^www\./, '');
}

function mdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

function resolveKey(domain) {
  const known = new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)]);
  let d = normalize(domain);
  if (!d) return null;
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    const key = ALIAS[cand] || cand;
    if (known.has(key)) return key;
  }
  return ALIAS[d] || d;
}

function readIf(dir, key) {
  try {
    return fs.readFileSync(path.join(dir, key + '.md'), 'utf8').trim();
  } catch {
    return null;
  }
}

const HINT =
  '[Learnings are hints, not rules. They record how a site behaved at some point in time; sites redesign and environments differ. ' +
  'When they disagree with what you observe, trust the page, and rewrite the note with learnings(domain, save) when you finish.]';

//

//

const PLAYBOOK_RE = /```act\s*\n([\s\S]*?)```/g;

export function lintPlaybooks(md) {
  const warns = [];
  let m, i = 0;
  PLAYBOOK_RE.lastIndex = 0;
  while ((m = PLAYBOOK_RE.exec(String(md || ''))) !== null) {
    i++;
    let steps;
    try {
      
      steps = JSON.parse(m[1].replace(/\{\{[^{}]*\}\}/g, 'X'));
    } catch (e) {
      warns.push(`playbook block ${i}: not valid JSON (${String(e.message).slice(0, 60)})`);
      continue;
    }
    if (!Array.isArray(steps) || !steps.length) { warns.push(`playbook block ${i}: expected an act steps array`); continue; }
    const bad = validateScript(steps);
    if (bad) warns.push(`playbook block ${i}: ${bad}`);
  }
  return warns;
}

const countPlaybooks = (md) => (String(md || '').match(PLAYBOOK_RE) || []).length;

export function getLearnings(domain) {
  if (!domain) {
    const all = [...new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)])].sort();
    return all.length
      ? `Sites with learnings: ${all.join(', ')}\nCall again with {domain} to read one.`
      : 'No learnings yet. When you learn something non-obvious while working, save it with {domain, save}.';
  }
  const key = resolveKey(domain);
  const seed = readIf(SEED_DIR, key);
  const local = readIf(LEARNINGS_DIR, key);
  if (!seed && !local) {
    const all = [...new Set([...mdFiles(SEED_DIR), ...mdFiles(LEARNINGS_DIR)])].sort();
    return (
      `No learnings for "${key}" yet. Follow the general flow; do not let an empty lookup slow the task.\n` +
      (all.length ? `Sites with learnings: ${all.join(', ')}\n` : '') +
      `Once you have mapped this site, save what you found with {domain: "${key}", save} so the next run is faster.`
    );
  }
  const parts = [HINT];
  if (seed) parts.push(`## Bundled learnings (beat-browser v${VERSION})\n\n${seed}`);
  if (local) parts.push(`## Local learnings\n\n${local}`);
  
  const n = countPlaybooks(parts.join('\n'));
  if (n) {
    parts.push(`[The notes above contain ${n} runnable playbook(s) (\`\`\`act blocks): the body is an act steps array. `
      + `Fill the {{placeholders}} and run it as-is; one act replaces dozens of trial-and-error turns. `
      + `Playbooks can go stale: assert/until stops the run when the page disagrees. Then continue by hand and write the new flow back when you finish.]`);
  }
  return parts.join('\n\n');
}

export function saveLearnings(domain, content) {
  const key = resolveKey(domain);
  if (!key) return 'Missing domain; nothing saved.';
  const body = String(content || '').trim();
  if (!body) return 'Empty content; nothing saved. To clear a local note, say so explicitly and delete the file by hand.';
  fs.mkdirSync(LEARNINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(LEARNINGS_DIR, key + '.md'), body + '\n');
  const warns = lintPlaybooks(body);
  return `Saved → learnings/${key}.md (${body.length} chars). The local note is overwritten as a whole: get and merge the old content before the next save.`
    + (warns.length
      ? `\nWARNING: playbook lint failed: ${warns.join('; ')}. Saved anyway (learnings never block), but running these playbooks next session will fail. Fix and save again.`
      : '');
}
