
//

//

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents.json'), 'utf8'),
).agents;

// gemini-cli-mcp-client → gemini, cursor-vscode → cursor, roo-code → roo

//

const ALIAS = { 'claude-ai': 'claude-desktop' };

const GENERIC = new Set(['', 'mcp', 'client', 'unknown', 'anonymous']);

// "Codex-MCP-Client" → codex; "Roo Code" → roo-code
export function slugOf(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/(-mcp)?-(client|host)$/, '')
    .replace(/^-+|-+$/g, '');
  return ALIAS[s] || s;
}

export function resolveHost({ clientInfo, flag } = {}) {
  const raw = clientInfo?.name;
  const slug = slugOf(raw);
  if (!GENERIC.has(slug)) {
    const known = AGENTS.find((a) => slug === a.client || slug.startsWith(a.client + '-'));
    return { client: known ? known.client : slug, label: known?.name, raw, source: 'clientInfo' };
  }
  const f = slugOf(flag);
  const known = AGENTS.find((a) => f === a.client);
  return { client: GENERIC.has(f) ? 'unknown' : f, label: known?.name, raw, source: 'flag' };
}
