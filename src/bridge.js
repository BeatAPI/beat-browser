
//

//

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import { DEFAULT_PORT, writeBridgeInfo, newToken, tokenEquals, audit, ensureHome, ALLOWLIST_FILE } from './lib/paths.js';
import { VERSION } from './lib/version.js';

import { scrubProse } from '../extension/redact.js';

export { VERSION };
const PROTOCOL = 1;
const HELLO_TIMEOUT = 5000;
const CMD_TIMEOUT = 30000;
const IDLE_EXIT_MS = 30 * 60 * 1000; 
const EXT_SILENCE_MS = 50000;        
const EXT_PROBE_MS = 15000;          
const ORPHAN_GRACE_MS = 15000;       

export function startBridge({ port = DEFAULT_PORT, token = newToken(), writeInfo = true, orphanGraceMs = ORPHAN_GRACE_MS,
  silenceMs = EXT_SILENCE_MS, probeMs = EXT_PROBE_MS, tickMs = 20000 } = {}) {
  ensureHome();

  const agents = new Set();      
  
  //
  
  
  
  
  //
  
  
  
  const extensions = new Set();
  
  
  const pending = new Map();
  let connSeq = 0;

  
  //
  
  
  
  
  
  //
  
  
  
  //
  
  
  const waiting = [];
  const WAIT_CAP = 64;                 
  const WAIT_MAX = 40000;              
  
  
  const NO_EXT_MSG = `The extension is not connected to the bridge. The bridge already waited ${WAIT_MAX / 1000}s for it. `
    + 'Ask the user to click the BeatBrowser icon in the Chrome toolbar and press "Reconnect" (the extension did not disappear, only the link dropped). '
    + 'Open Chrome if it is closed. Reload it at chrome://extensions only after changing extension code.';

  let lastActivity = Date.now();

  
  
  
  //
  
  
  
  
  
  const liveSessions = () => [...new Set([...agents].map((a) => a.sid).filter(Boolean))];

  
  //
  
  
  
  
  const liveExtensions = () => [...extensions].filter((e) => e.readyState === 1);
  function primary() {
    const live = liveExtensions();
    if (!live.length) return null;
    const headed = live.filter((e) => !e.headless);
    const pool = headed.length ? headed : live;
    return pool.reduce((a, b) => (a.lastRx >= b.lastRx ? a : b));
  }
  const extLabel = (ws) => `Chrome ${ws.chromeVersion || '?'}${ws.headless ? ' · headless' : ''} · extension ${ws.extVersion}`;

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info, done) => {
      const origin = info.req.headers.origin;
      if (origin === undefined) return done(true);              
      if (origin.startsWith('chrome-extension://')) return done(true);
      audit({ ev: 'reject_origin', origin });                   
      done(false, 403, 'forbidden origin');
    },
  });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    ws.isExtension = typeof origin === 'string' && origin.startsWith('chrome-extension://');
    ws.helloed = false;
    ws.connId = ++connSeq;
    ws.lastRx = Date.now();

    const helloTimer = setTimeout(() => {
      if (!ws.helloed) ws.close(4008, 'hello timeout');
    }, HELLO_TIMEOUT);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'res', ok: false, error: { code: 'INTERNAL', message: 'Invalid JSON' } });
      }
      lastActivity = Date.now();
      ws.lastRx = lastActivity;

      if (!ws.helloed) {
        clearTimeout(helloTimer);
        return handleHello(ws, msg);
      }
      route(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (agents.delete(ws)) {
        
        
        
        
        //
        
        for (let i = waiting.length - 1; i >= 0; i--) {
          if (waiting[i].ws === ws) { clearTimeout(waiting[i].timer); waiting.splice(i, 1); }
        }
        
        
        
        
        for (const e of liveExtensions()) {
          send(e, { type: 'event', event: 'sessions', live: liveSessions() });
        }
      }
      if (extensions.delete(ws)) {
        log(`extension disconnected (${extLabel(ws)})`);
        
        //
        
        
        
        
        
        
        
        for (const [k, p] of pending) {
          if (p.ext !== ws || p.orphanTimer) continue;
          p.orphanTimer = setTimeout(() => {
            if (!pending.has(k)) return;
            clearTimeout(p.timer);
            pending.delete(k);
            send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION',
              message: `The extension disconnected mid-command and did not return within ${orphanGraceMs / 1000}s. The command may already have taken effect on the page. `
                + 'Take a snapshot before retrying so one click does not become two.' } });
          }, orphanGraceMs);
        }
        
        if (!liveExtensions().length) broadcast({ type: 'event', event: 'extension_offline' });
      }
    });

    ws.on('error', () => {});
  });

  function handleHello(ws, msg) {
    if (msg.type !== 'hello') return ws.close(4000, 'expected hello');

    if (msg.role === 'extension') {
      if (!ws.isExtension) return ws.close(4003, 'role/origin mismatch');
      ws.helloed = true;
      ws.extVersion = msg.version || '?';
      ws.chromeVersion = msg.chrome || '?';
      ws.headless = !!msg.headless;
      
      
      ws.instanceId = msg.instanceId || `ext:${msg.extId || '?'}`;

      
      
      for (const old of extensions) {
        if (old.instanceId === ws.instanceId && old !== ws) {
          extensions.delete(old);
          if (old.readyState === 1) old.close(4009, 'replaced');
        }
      }
      extensions.add(ws);

      
      
      if (ws.extVersion !== VERSION) {
        log(`WARNING: version mismatch: extension ${ws.extVersion} vs bridge ${VERSION}. Reload the extension at chrome://extensions`);
      }
      log(`extension connected (${extLabel(ws)})`);
      
      
      const live = liveExtensions();
      if (live.length > 1) {
        log(`WARNING: ${live.length} Chrome instances are connected (${live.map(extLabel).join(' / ')}); `
          + `commands route to: ${extLabel(primary())}`);
      }
      send(ws, { type: 'welcome', bridge: VERSION, v: PROTOCOL });
      broadcast({ type: 'event', event: 'extension_online' });
      flushWaiting();
      return;
    }

    if (msg.role === 'agent') {
      if (ws.isExtension) return ws.close(4003, 'role/origin mismatch');
      if (!tokenEquals(msg.token || '', token)) {
        audit({ ev: 'reject_token', client: msg.client });
        return ws.close(4001, 'bad token');
      }
      agents.add(ws);
      ws.helloed = true;
      ws.client = msg.client || 'unknown';
      
      
      ws.label = typeof msg.label === 'string' && msg.label ? msg.label.slice(0, 40) : undefined;
      
      
      ws.sid = msg.sessionId || `conn:${ws.connId}`;
      log(`agent connected: ${ws.label || ws.client} (${ws.client}, session ${ws.sid})`);
      const ext = primary();
      send(ws, {
        type: 'welcome', bridge: VERSION, v: PROTOCOL,
        extensionOnline: !!ext,
        extensionVersion: ext?.extVersion,
        versionMismatch: !!ext && ext.extVersion !== VERSION,
        
        
        extensions: liveExtensions().map((e) => ({
          chrome: e.chromeVersion, version: e.extVersion, headless: e.headless, primary: e === ext,
        })),
      });
      return;
    }

    ws.close(4000, 'unknown role');
  }

  function route(ws, msg) {
    // agent → extension
    if (msg.type === 'cmd') {
      if (!agents.has(ws)) return;
      const target = primary();
      if (!target) return enqueue(ws, msg);
      return dispatch(ws, msg, target);
    }

    // extension → agent
    return routeBack(ws, msg);
  }

  
  
  
  function enqueue(ws, msg) {
    const fail = () => send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'NO_EXTENSION', message: NO_EXT_MSG } });
    if (waiting.length >= WAIT_CAP) return fail();

    const ms = Math.min(Number(msg.timeout) || WAIT_MAX, WAIT_MAX);
    const item = { ws, msg };
    item.timer = setTimeout(() => {
      const i = waiting.indexOf(item);
      if (i >= 0) waiting.splice(i, 1);
      fail();
    }, ms);
    waiting.push(item);
    
    audit({ ev: 'queued', id: `${ws.connId}:${msg.id}`, cmd: msg.cmd, client: ws.client, waitMs: ms });
  }

  
  
  function flushWaiting() {
    const q = waiting.splice(0);
    for (const it of q) {
      clearTimeout(it.timer);
      if (agents.has(it.ws) && it.ws.readyState === 1) dispatch(it.ws, it.msg);
    }
    if (q.length) log(`extension is back, replaying ${q.length} queued commands`);
  }

  function dispatch(ws, msg, target = primary()) {
    if (!target) return enqueue(ws, msg);
    const gate = checkSite(msg);
    if (gate) {
      audit({ ev: 'blocked', cmd: msg.cmd, client: ws.client, reason: gate.code });
      return send(ws, { type: 'res', id: msg.id, ok: false, error: gate });
    }

    
    const ms = Math.min(Math.max(Number(msg.timeout) || CMD_TIMEOUT, 1000), 600000);
    const key = `${ws.connId}:${msg.id}`;
    const timer = setTimeout(() => {
      clearTimeout(pending.get(key)?.orphanTimer);
      pending.delete(key);
      send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'TIMEOUT', message: `Extension did not respond within ${Math.round(ms / 1000)}s` } });
    }, ms);

    
    pending.set(key, { agent: ws, ext: target, cmd: msg.cmd, timer, startedAt: Date.now(), id: msg.id });
    
    
    
    
    
    audit({ ev: 'cmd', id: key, cmd: msg.cmd, client: ws.client, sid: ws.sid, params: redact(msg.params) });
    
    
    
    send(target, { ...msg, __k: key, sid: ws.sid, client: ws.client, label: ws.label, live: liveSessions() });   
  }

  function routeBack(ws, msg) {
    
    
    
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (msg.type === 'pong') return;   

    // extension → agent
    if (msg.type === 'res') {
      if (!extensions.has(ws)) return;
      let key = msg.__k;
      let p = key ? pending.get(key) : null;
      if (!p) {
        
        for (const [k, v] of pending) if (v.id === msg.id) { key = k; p = v; break; }
      }
      if (!p) return; 
      clearTimeout(p.timer);
      clearTimeout(p.orphanTimer);   
      pending.delete(key);
      
      
      audit({ ev: 'res', id: key, cmd: p.cmd, ok: msg.ok, ms: Date.now() - p.startedAt, error: msg.error?.code,
        bytes: msg.ok ? JSON.stringify(msg.data ?? '').length : undefined });
      const { __k, ...clean } = msg;
      send(p.agent, clean);
      return;
    }

    if (msg.type === 'event' && extensions.has(ws)) broadcast(msg);
  }

  
  
  function checkSite(msg) {
    const url = msg.params?.url;
    if (!url) return null;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    } catch {
      return null;
    }
    if (list.mode !== 'allowlist') return null;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const ok = (list.sites || []).some((s) => host === s || host.endsWith('.' + s));
    return ok ? null : { code: 'SITE_NOT_ALLOWED', message: `${host} is not in the authorized site list. Authorize it in the extension popup.` };
  }

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function broadcast(obj) {
    for (const a of agents) send(a, obj);
  }
  
  
  function log(m) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${m}`);
  }

  const ready = new Promise((resolve) => {
    wss.on('listening', () => {
      if (writeInfo) writeBridgeInfo({ port, token, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() });
      log(`bridge started on ws://127.0.0.1:${port}`);
      resolve();
    });
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${port} is already in use; a bridge is probably already running`);
      process.exit(3);
    }
    throw e;
  });

  
  
  
  if (writeInfo) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        log(`received ${sig}, shutting down`);
        for (const [, p] of pending) {
          send(p.agent, { type: 'res', id: p.id, ok: false, error: { code: 'NO_EXTENSION', message: 'The bridge is restarting (usually a version upgrade). Retry once.' } });
        }
        for (const c of wss.clients) c.close(1001, 'bridge shutting down');
        wss.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      });
    }
  }

  const idleTimer = setInterval(() => {
    
    
    
    
    //
    
    
    
    
    
    const now = Date.now();
    for (const e of liveExtensions()) {
      const silent = now - e.lastRx;
      if (silent <= silenceMs) { e.probedAt = 0; continue; }
      if (!e.probedAt) { e.probedAt = now; send(e, { type: 'ping' }); continue; }
      if (now - e.probedAt >= probeMs) {
        log(`extension went silent; no reply to a probe after ${Math.round((now - e.probedAt) / 1000)}s, treating the connection as dead (${extLabel(e)})`);
        e.terminate();
      }
    }
    if (writeInfo && agents.size === 0 && !liveExtensions().length && Date.now() - lastActivity > IDLE_EXIT_MS) {
      log('idle timeout, bridge exiting');
      process.exit(0);
    }
  }, tickMs);
  idleTimer.unref();

  return { wss, port, token, ready, close: () => { clearInterval(idleTimer); wss.close(); for (const c of wss.clients) c.terminate(); } };
}

//

//

//

const SECRET_KEYS = new Set(['text', 'value', 'password', 'token', 'secret', 'code']);

function scrub(v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  
  
  if (typeof v !== 'object') return typeof v === 'string' ? scrubProse(v) : v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && SECRET_KEYS.has(k)) out[k] = `<${val.length} chars>`;
    
    else if (k === 'base64' && typeof val === 'string') out[k] = `<${Math.round(val.length * 0.75 / 1024)}KB>`;
    else if (k === 'expr' && typeof val === 'string' && val.length > 200) out[k] = val.slice(0, 200) + '…';
    else out[k] = scrub(val, depth + 1);
  }
  return out;
}

export function redact(params) {
  if (!params || typeof params !== 'object') return params;
  return scrub(params);
}
