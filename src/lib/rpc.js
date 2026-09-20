
//

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_PORT, LOCK_FILE, LOG_FILE, BRIDGE_FILE, readBridgeInfo, ensureHome } from './paths.js';
import { VERSION } from './version.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

//

function makeSessionId(client) {
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return `${client}:r${Math.random().toString(36).slice(2, 10)}`;
  return `${client}:p${ppid}`;
}

export class BridgeClient {
  
  
  constructor({ client = 'unknown', sessionId, label } = {}) {
    this.client = client;
    this.label = label;
    this.pinnedSid = !!sessionId;
    this.sessionId = sessionId || makeSessionId(client);
    this.ws = null;
    this.seq = 0;
    this.waiting = new Map();
    this.extensionOnline = false;
    this.onEvent = () => {};
  }

  
  
  
  identify(client, label) {
    if (this.ws) return false;
    this.client = client;
    this.label = label;
    if (!this.pinnedSid) this.sessionId = makeSessionId(client);
    return true;
  }

  async connect({ timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let spawned = false;
    while (Date.now() < deadline) {
      const info = readBridgeInfo();
      
      
      
      if (info && info.version && info.version !== VERSION && !spawned) {
        stopBridge(info);
        spawned = tryStartBridge();
        await sleep(400);
        continue;
      }
      if (info) {
        try {
          await this.#open(info);
          return this;
        } catch {
          
        }
      }
      if (!spawned) spawned = tryStartBridge();
      await sleep(250);
    }
    throw new Error('Cannot reach the beat-browser bridge. Run `beat-browser doctor` to see where it is stuck');
  }

  #open(info) {
    return new Promise((resolve, reject) => {
      
      const ws = new WebSocket(`ws://127.0.0.1:${info.port || DEFAULT_PORT}`);
      const fail = (e) => reject(e instanceof Error ? e : new Error('Bridge connection failed'));
      const t = setTimeout(() => { ws.close(); fail(new Error('Handshake timed out')); }, 4000);

      ws.onerror = fail;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'agent', token: info.token, client: this.client, label: this.label, sessionId: this.sessionId, v: 1 }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'welcome') {
          clearTimeout(t);
          this.ws = ws;
          this.extensionOnline = !!msg.extensionOnline;
          this.extensionVersion = msg.extensionVersion;
          this.versionMismatch = !!msg.versionMismatch;
          ws.onmessage = (e2) => this.#dispatch(JSON.parse(e2.data));
          ws.onclose = () => { this.ws = null; this.#failAll('Bridge connection closed'); };
          ws.onerror = () => {};
          return resolve(this);
        }
        clearTimeout(t);
        fail(new Error('Handshake rejected: ' + (msg.error?.message || JSON.stringify(msg))));
      };
    });
  }

  #dispatch(msg) {
    if (msg.type === 'res') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      msg.ok ? w.resolve(msg.data ?? {}) : w.reject(Object.assign(new Error(msg.error?.message || 'Command failed'), { code: msg.error?.code || 'INTERNAL' }));
      return;
    }
    if (msg.type === 'event') {
      if (msg.event === 'extension_online') this.extensionOnline = true;
      if (msg.event === 'extension_offline') this.extensionOnline = false;
      this.onEvent(msg);
    }
  }

  
  
  close() {
    this.#failAll('Client closed the connection');
    try { this.ws?.close(1000, 'bye'); } catch {  }
    this.ws = null;
  }

  #failAll(reason) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error(reason), { code: 'INTERNAL' }));
    }
    this.waiting.clear();
  }

  
  async call(cmd, params = {}, { tabId, timeoutMs = 35000 } = {}) {
    if (!this.ws) await this.connect();
    const id = 'c' + ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Object.assign(new Error('Bridge did not respond'), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      
      this.ws.send(JSON.stringify({ type: 'cmd', id, cmd, params, tabId, timeout: timeoutMs - 3000 }));
    });
  }
}

export function stopBridge(info) {
  if (!info?.pid) return false;
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    return false; 
  }
  try { fs.unlinkSync(BRIDGE_FILE); } catch {}
  return true;
}

export function tryStartBridge() {
  ensureHome();
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx'); 
  } catch {
    const age = Date.now() - (fs.statSync(LOCK_FILE).mtimeMs || 0);
    if (age > 30000) { try { fs.unlinkSync(LOCK_FILE); } catch {} } 
    return false;
  }
  try {
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [CLI, 'bridge'], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return true;
  } finally {
    fs.closeSync(fd);
    setTimeout(() => { try { fs.unlinkSync(LOCK_FILE); } catch {} }, 3000).unref?.();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
