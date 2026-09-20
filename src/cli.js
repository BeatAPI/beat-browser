#!/usr/bin/env node
// beat-browser CLI

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBridgeInfo, DEFAULT_PORT, HOME, AUDIT_FILE, LOG_FILE } from './lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]) : d; };
const has = (k) => argv.includes(k);

switch (cmd) {
  case 'mcp': {
    const { startMcpServer } = await import('./mcp-server.js');
    
    await startMcpServer({ client: flag('--client', 'unknown') });
    break;
  }

  case 'bridge': {
    const { startBridge } = await import('./bridge.js');
    startBridge({ port: Number(flag('--port', DEFAULT_PORT)), foreground: has('--foreground') });
    break;
  }

  
  //   beat-browser call snapshot
  //   beat-browser call tabs '{"action":"new","url":"https://example.com"}'
  case 'call': {
    
    if (argv[1] === 'learnings') {
      const { getLearnings, saveLearnings } = await import('./lib/learnings.js');
      const p = argv[2] ? JSON.parse(argv[2]) : {};
      console.log(p.save != null ? saveLearnings(p.domain, p.save) : getLearnings(p.domain));
      break;
    }
    const { BridgeClient } = await import('./lib/rpc.js');
    const c = new BridgeClient({ client: 'cli' });
    await c.connect();
    const params = argv[2] ? JSON.parse(argv[2]) : {};
    if (argv[1] === 'upload' && params.path) {
      const buf = fs.readFileSync(params.path);
      const ext = path.extname(params.path).toLowerCase();
      params.type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
      params.name = path.basename(params.path);
      params.base64 = buf.toString('base64');
      delete params.path;
    }
    try {
      const data = await c.call(argv[1], params, { tabId: params.tabId });
      
      
      if (data?.path && params.savePath) {
        fs.mkdirSync(path.dirname(params.savePath), { recursive: true });
        fs.renameSync(data.path, params.savePath);
        console.log(`${Math.round((data.bytes || 0) / 1024)}KB → ${params.savePath}`);
        process.exit(0);
      }
      if (data?.base64) {
        const out = params.savePath || path.join(process.cwd(), `download-${Date.now()}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(data.base64, 'base64'));
        console.log(`${Math.round(data.bytes / 1024)}KB ${data.ct} → ${out}`);
        process.exit(0);
      }
      
      if (data?.dataUrl) {
        const out = params.savePath || path.join(process.cwd(), `screenshot-${Date.now()}.png`);
        fs.writeFileSync(out, Buffer.from(data.dataUrl.split(',')[1], 'base64'));
        console.log(out);
        process.exit(0);
      }
      
      
      
      const text = typeof data === 'string' ? data : (data.text ?? JSON.stringify(data, null, 2));
      process.stdout.write(text + '\n', () => process.exit(0));
      break;
    } catch (e) {
      console.error(`[${e.code || 'INTERNAL'}] ${e.message}`);
      process.exit(1);
    }
  }

  case 'install': {
    const { install } = await import('./install.js');
    await install({ yes: !has('--dry-run'), only: flag('--only', null) });
    break;
  }

  case 'doctor':
    await doctor();
    break;

  case 'extension':
    printExtension();
    
    
    
    if (has('--reveal')) revealExtensionDir();
    break;

  case 'audit': {
    if (has('--stats')) { auditStats(Number(flag('--days', 7))); break; }
    const n = Number(flag('-n', 30));
    const lines = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n) : [];
    if (!lines.length) console.log('No audit records yet.');
    for (const l of lines) {
      const e = JSON.parse(l);
      console.log(`${e.t.slice(11, 19)}  ${(e.ev + '        ').slice(0, 8)} ${e.cmd || ''} ${e.ok === false ? '✗ ' + (e.error || '') : ''}`);
    }
    break;
  }

  default:
    console.log(`beat-browser: let any AI agent control your own Chrome

  beat-browser install        install: configure every detected agent, then guide the extension setup
  beat-browser mcp            start the MCP server (agent configs point here; install writes it for you)
  beat-browser doctor         diagnose connection problems
  beat-browser extension      print the extension loading steps
  beat-browser audit [-n 30]  show recent browser operations
  beat-browser audit --stats [--days 7]   usage stats: turns, busiest commands, where time is wasted
  beat-browser bridge --foreground        run the bridge in the foreground (debugging)
  beat-browser install --dry-run          show which configs would change, write nothing

Config directory: ${HOME}`);
}

async function doctor() {
  const ok = (s) => console.log(`  ✅ ${s}`);
  const bad = (s, fix) => { console.log(`  ❌ ${s}`); if (fix) console.log(`     → ${fix}`); };

  console.log('\nbeat-browser doctor\n');

  console.log('Config directory');
  fs.existsSync(HOME) ? ok(HOME) : bad(`${HOME} does not exist`, 'Run `beat-browser mcp` once; it creates the directory');

  console.log('\nBridge');
  let info = readBridgeInfo();
  let alive = false;
  if (info) { try { process.kill(info.pid, 0); alive = true; } catch {} }
  if (!alive) {
    
    
    
    console.log(`  ·  Bridge is not running${info ? ` (bridge.json points at pid ${info.pid}, which is gone)` : ''}; starting it and probing again…`);
    const { tryStartBridge } = await import('./lib/rpc.js');
    tryStartBridge();
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 300));
      info = readBridgeInfo();
      if (info?.pid) { try { process.kill(info.pid, 0); alive = true; break; } catch {} }
    }
    if (!alive) {
      bad('Bridge failed to start', `See the last lines of ${LOG_FILE}. This also happens when another program holds port ${DEFAULT_PORT} (lsof -i :${DEFAULT_PORT})`);
    }
  }
  if (alive) {
    ok(`pid ${info.pid} · port ${info.port} · started ${info.startedAt ? new Date(info.startedAt).toLocaleTimeString('en-GB', { hour12: false }) : '?'}`);
    {
      const r = await probe(info);
      r.ok ? ok(`Handshake OK${r.extensionOnline ? ` · Chrome extension online (v${r.extensionVersion})` : ''}`) : bad('Handshake failed: ' + r.error);
      if (r.versionMismatch) bad(`Extension version ${r.extensionVersion} does not match the CLI`, 'Reload it at chrome://extensions, then refresh the target page');
      
      
      if ((r.extensions || []).length > 1) {
        console.log(`  ℹ️  ${r.extensions.length} Chrome instances are connected to the bridge:`);
        for (const e of r.extensions) {
          console.log(`       ${e.primary ? '→' : ' '} Chrome ${e.chrome} · extension ${e.version}${e.headless ? ' · headless' : ''}${e.primary ? ' (commands go here)' : ''}`);
        }
        if (r.extensions.some((e) => e.headless)) {
          console.log('       The headless one is usually an orphan from an earlier scrape; safe to kill');
        }
      }
      if (r.ok && !r.extensionOnline) {
        
        
        
        bad('The Chrome extension is not connected to the bridge right now',
          'Click the BeatBrowser icon in the Chrome toolbar and press "Reconnect", then run doctor again (the extension did not disappear, only the link dropped). '
          + 'No icon? Chrome is closed, or the extension is not installed or is disabled: load it from the directory printed under "Extension" below.');
      }
    }
  }

  console.log('\nExtension');
  const mf = path.join(ROOT, 'extension', 'manifest.json');
  fs.existsSync(mf)
    ? ok(`${path.join(ROOT, 'extension')} (this only proves the files exist; check the "extension online" line above to see whether Chrome loaded them)`)
    : bad('Extension directory is missing', 'Reinstall beat-browser');

  
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-400);
    let lastDown = null, lastUp = null;
    for (const l of lines) {
      if (l.includes('extension disconnected')) lastDown = l.slice(1, 9);
      else if (l.includes('extension connected')) lastUp = l.slice(1, 9);
    }
    if (lastDown) console.log(`  ·  Last disconnect ${lastDown}${lastUp ? `, last connect ${lastUp}` : ', no reconnect since'} (bridge.log, time of day only)`);
  } catch {  }

  
  
  try {
    const { LEARNINGS_DIR } = await import('./lib/learnings.js');
    const hits = [];
    for (const f of fs.readdirSync(LEARNINGS_DIR)) {
      if (!f.endsWith('.md')) continue;
      for (const line of fs.readFileSync(path.join(LEARNINGS_DIR, f), 'utf8').split('\n')) {
        if (/beat-browser/.test(line) && /worked|broken|bug|silent|bypass|fail|invalid|noop/i.test(line)) hits.push(`${f}: ${line.trim().slice(0, 110)}`);
        if (hits.length >= 6) break;
      }
    }
    if (hits.length) {
      console.log('\nProduct problems noted in the learnings (written by agents, worth a look)');
      for (const h of hits) console.log(`  ·  ${h}`);
    }
  } catch {  }

  console.log('\nLogs');
  console.log(`  bridge log   ${LOG_FILE}`);
  console.log(`  audit log    ${AUDIT_FILE}   (view with: beat-browser audit)`);
  console.log('');
}

function auditStats(days) {
  if (!fs.existsSync(AUDIT_FILE)) return console.log('No audit records yet.');
  const since = Date.now() - days * 86400000;
  const rows = [];
  for (const l of fs.readFileSync(AUDIT_FILE, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (Date.parse(r.t) >= since) rows.push(r); } catch {  }
  }
  const isReal = (c) => c && !/^(test|cli|doctor|probe|dbg|smoke|live|stamp|agent-|old-|stayer|reloader|cleanup|c$)/.test(c);
  
  
  const cmds = [];
  const res = new Map();
  const open = new Map();
  for (const r of rows) {
    if (r.ev === 'cmd') { if (isReal(r.client)) { cmds.push(r); open.set(r.id, r); } }
    else if (r.ev === 'res' && open.has(r.id)) { res.set(open.get(r.id), r); open.delete(r.id); }
  }
  if (!cmds.length) return console.log(`No real agent calls in the last ${days} days.`);

  const count = new Map();
  for (const r of cmds) count.set(r.cmd, (count.get(r.cmd) || 0) + 1);
  const bySid = new Map();
  for (const r of cmds) { if (!bySid.has(r.sid)) bySid.set(r.sid, []); bySid.get(r.sid).push(r); }
  const bigrams = new Map();
  const gaps = [];
  for (const list of bySid.values()) {
    list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const k = `${a.cmd}→${b.cmd}`;
      bigrams.set(k, (bigrams.get(k) || 0) + 1);
      const g = (Date.parse(b.t) - Date.parse(a.t) - (res.get(a)?.ms || 0)) / 1000;
      if (g > 0 && g < 600) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const pct = (p) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1) : '-';
  const ms = new Map();
  let bytes = 0, bytesN = 0;
  for (const r of cmds) {
    const rr = res.get(r);
    if (!rr) continue;
    if (rr.ms !== undefined) { if (!ms.has(r.cmd)) ms.set(r.cmd, []); ms.get(r.cmd).push(rr.ms); }
    if (rr.bytes !== undefined) { bytes += rr.bytes; bytesN++; }
  }
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const writes = ['click', 'type', 'select', 'fill', 'key', 'navigate'].reduce((n, c) => n + (count.get(c) || 0), 0);
  const act = count.get('act') || 0;
  const evalN = count.get('eval') || 0;

  console.log(`\nLast ${days} days · ${cmds.length} real agent calls · ${bySid.size} sessions\n`);
  console.log('Command mix (count · share · median exec ms)');
  for (const [c, n] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(12)} ${String(n).padStart(5)}  ${(100 * n / cmds.length).toFixed(1).padStart(5)}%  ${ms.has(c) ? String(med(ms.get(c))).padStart(6) : '     -'}`);
  }
  console.log(`\nGap between commands (≈ one model turn): median ${pct(0.5)}s · p90 ${pct(0.9)}s · n=${gaps.length}`);
  console.log(`act share of write ops ${act}/${act + writes} (${act + writes ? (100 * act / (act + writes)).toFixed(1) : 0}%) · eval ${evalN} calls (${(100 * evalN / cmds.length).toFixed(1)}%)`);
  if (bytesN) console.log(`Mean receipt size ${Math.round(bytes / bytesN / 1024)}KB (${bytesN} recorded)`);
  console.log('\nTop 10 adjacent pairs (a repeat means the first call did not answer the question)');
  for (const [k, n] of [...bigrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(24)} ${n}`);
  const errs = new Map();
  for (const r of cmds) { const rr = res.get(r); if (rr && rr.ok === false) { const k = `${r.cmd} ${rr.error || ''}`; errs.set(k, (errs.get(k) || 0) + 1); } }
  if (errs.size) {
    console.log('\nTop 8 errors');
    for (const [k, n] of [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${k.padEnd(28)} ${n}`);
  }
  console.log('');
}

function probe(info) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`);
    const t = setTimeout(() => { ws.close(); resolve({ ok: false, error: 'timeout' }); }, 3000);
    ws.onerror = () => { clearTimeout(t); resolve({ ok: false, error: 'connection refused' }); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: info.token, client: 'doctor', v: 1 }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      const m = JSON.parse(ev.data);
      ws.close();
      resolve(m.type === 'welcome'
        ? { ok: true, extensionOnline: m.extensionOnline, extensionVersion: m.extensionVersion, versionMismatch: m.versionMismatch, extensions: m.extensions || [] }
        : { ok: false, error: JSON.stringify(m) });
    };
  });
}

function printExtension() {
  const dir = path.join(ROOT, 'extension');
  console.log(`
Load the extension in Chrome (BeatBrowser is not on the Chrome Web Store):

  1. Open chrome://extensions and turn on "Developer mode" (top right)
  2. Click "Load unpacked" and select this folder (or drag it onto the page):

       ${dir}

     Add --reveal to select it in Finder / Explorer so you can drag it over.

Once loaded the extension connects to the bridge by itself. Run \`beat-browser doctor\`
and look for "Chrome extension online".
`);
}

function revealExtensionDir() {
  const dir = path.join(ROOT, 'extension');
  try {
    if (process.platform === 'darwin') spawn('open', ['-R', dir], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('explorer', ['/select,' + dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [path.dirname(dir)], { detached: true, stdio: 'ignore' }).unref();
  } catch {  }
}
