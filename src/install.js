
//

//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const H = os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function appData() {
  if (WIN) return process.env.APPDATA || path.join(H, 'AppData', 'Roaming');
  if (MAC) return path.join(H, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(H, '.config');
}

const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'agents.json'), 'utf8'));

const expand = (p) => p
  .replace(/^~/, H)
  .replace(/^\$APPDATA/, appData())
  .split('/').join(path.sep);

function knownAgents() {
  return SPEC.agents.map((a) => ({
    ...a,
    file: a.paths.map(expand).find((f) => fs.existsSync(f)) || null,
  }));
}

function discover(knownFiles) {
  const out = [];
  
  
  
  
  const claimed = new Set();
  for (const a of SPEC.agents) {
    for (const f of a.paths.map(expand)) {
      claimed.add(f);
      claimed.add(path.dirname(f));
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(H, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.')) continue;
    if (SPEC._discovery.skipDirs.includes(e.name)) continue;
    for (const fname of SPEC._discovery.filenames) {
      const f = path.join(H, e.name, ...fname.split('/'));
      if (knownFiles.has(f) || claimed.has(f) || claimed.has(path.dirname(f))) continue;
      if (!fs.existsSync(f) || out.some((o) => o.file === f)) continue;
      if (!looksLikeMcp(f)) continue;
      out.push({
        name: e.name.replace(/^\./, ''),
        client: e.name.replace(/^\./, ''),
        kind: f.endsWith('.toml') ? 'toml' : 'json',
        file: f,
        discovered: true,
      });
    }
  }
  return out;
}

function pad(s, width) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

function looksLikeMcp(f) {
  try {
    const raw = fs.readFileSync(f, 'utf8');
    if (!/"mcpServers"|\[mcp_servers/.test(raw)) return false;
    if (f.endsWith('.json')) JSON.parse(raw);   
    return true;
  } catch {
    return false;
  }
}

const FROM_NPM = ROOT.includes(`${path.sep}node_modules${path.sep}`);
const REPO = 'https://github.com/BeatAPI/beat-browser';

function nodeBin() {
  try {
    const out = execFileSync(WIN ? 'where' : 'which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    
    if (first && fs.existsSync(first) && !/[\\/]v?\d+\.\d+\.\d+[\\/]/.test(first)) return first;
  } catch {  }
  return process.execPath;
}

function launcher(client) {
  if (FROM_NPM) return { command: WIN ? 'npx.cmd' : 'npx', args: ['-y', '@beatapi/beat-browser', 'mcp', '--client', client] };
  return { command: nodeBin(), args: [path.join(ROOT, 'src', 'cli.js'), 'mcp', '--client', client] };
}

export async function install({ yes = true, only = null } = {}) {
  console.log('\nbeat-browser install\n');

  const all = knownAgents().filter((a) => a.file);
  const discovered = discover(new Set(all.map((a) => a.file)));
  let found = [...all, ...discovered];

  if (only) {
    found = found.filter((a) => a.client === only);
    if (!found.length) {
      console.log(`  ${only} was not found on this machine. Detected: ${[...all, ...discovered].map((a) => a.client).join(' / ') || '(none)'}\n`);
      return;
    }
  }

  if (!found.length) {
    console.log('  No agent MCP config was found on this machine.\n');
    console.log('  Known agents that are configured automatically: ' + SPEC.agents.map((a) => a.name).join(', '));
    console.log('  Unlisted agents are auto-discovered when they keep MCP config under ~/.<name>/.\n');
    console.log('  Otherwise add this to your agent\'s MCP config:\n');
    console.log('    ' + JSON.stringify({ mcpServers: { 'beat-browser': launcher('custom') } }, null, 2).split('\n').join('\n    '));
    console.log('');
    printExtensionStep();
    return;
  }

  console.log('Detected agents:');
  const plan = [];
  for (const t of found) {
    const done = alreadyConfigured(t);
    const tag = t.discovered ? ' (auto-discovered)' : '';
    console.log(`  ${done ? '·' : '+'} ${pad(t.name + tag, 26)} ${done ? 'already configured, skipping' : 'will write MCP config'}`);
    if (!done) plan.push(t);
  }

  if (!plan.length) {
    console.log('\nEvery detected agent is already configured.');
  } else {
    console.log(`\nThis will modify ${plan.length} config file(s); each is backed up to <file>.bak-<timestamp> first.`);
    if (!yes) {
      console.log('\n(--dry-run: nothing written. Re-run without it to apply.)\n');
      printExtensionStep();
      return;
    }
    let ok = 0;
    for (const t of plan) {
      try {
        const backup = `${t.file}.bak-${Date.now()}`;
        fs.copyFileSync(t.file, backup);
        t.kind === 'json' ? writeJson(t) : writeToml(t);
        console.log(`  ✅ ${t.name} (original backed up as ${path.basename(backup)})`);
        ok++;
      } catch (e) {
        console.log(`  ❌ ${t.name}: ${e.message}`);
        console.log(`     Adding it to ${t.file} by hand also works; the snippet is in the README`);
      }
    }
    if (ok) console.log(`\n${ok} agent(s) configured. Restart them once so they load the new MCP server.`);
  }

  printExtensionStep();
  console.log(`\nDone. If it helps you, a star is appreciated: ${REPO}\n`);
}

function printExtensionStep() {
  console.log('One more step: load the Chrome extension');
  console.log('  Run `beat-browser extension` for the steps (Chrome does not let a script install extensions),');
  console.log('  then `beat-browser doctor` to verify.');
}

function alreadyConfigured(t) {
  try {
    return fs.readFileSync(t.file, 'utf8').includes('beat-browser');
  } catch {
    return false;
  }
}

function writeJson(t) {
  const raw = fs.readFileSync(t.file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`this file is not valid JSON (${e.message}); not touching it`);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['beat-browser'] = launcher(t.client);
  fs.writeFileSync(t.file, JSON.stringify(cfg, null, 2) + '\n');
}

function writeToml(t) {
  const l = launcher(t.client);
  const block = [
    '',
    '# --- beat-browser (added by `beat-browser install`) ---',
    '[mcp_servers.beat-browser]',
    `command = ${JSON.stringify(l.command)}`,
    `args = [${l.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    '',
  ].join('\n');
  const prev = fs.readFileSync(t.file, 'utf8');
  fs.writeFileSync(t.file, prev + (prev.endsWith('\n') ? '' : '\n') + block);
}
