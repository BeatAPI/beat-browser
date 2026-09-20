
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = path.join(os.homedir(), '.beat-browser');
export const BRIDGE_FILE = path.join(HOME, 'bridge.json');
export const LOCK_FILE = path.join(HOME, 'bridge.lock');
export const AUDIT_FILE = path.join(HOME, 'audit.jsonl');
export const ALLOWLIST_FILE = path.join(HOME, 'allowlist.json');
export const LOG_FILE = path.join(HOME, 'bridge.log');

export const DEFAULT_PORT = 18899;

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  return HOME;
}

export function writeBridgeInfo(info) {
  ensureHome();
  const tmp = BRIDGE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BRIDGE_FILE);
}

export function readBridgeInfo() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function audit(entry) {
  try {
    ensureHome();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    
  }
}
