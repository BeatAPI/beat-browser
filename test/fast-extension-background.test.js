import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CRED_URL } from '../extension/redact.js';

const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const block = background.slice(background.indexOf('// Fast commands deliberately bypass'), background.indexOf('const HANDLERS = {'));

function harness() {
  const tabs = new Map([[1, { id: 1, windowId: 11, url: 'https://example.test/start', status: 'complete' }]]);
  const calls = [];
  const created = [];
  const updated = [];
  const config = { runId: 'background-run-0001', allowedDomains: ['example.test'], deadline: Date.now() + 30000 };
  const control = { injectionFails: false, pong: true, actionThrows: false, duringPing: null, duringInjection: null, afterAction: null, provisionalOpen: false, redirectsOnOpen: false };
  const snapshot = { snapshotId: 's1', url: 'https://example.test/start', title: 'Fixture', visibleText: 'Safe', elements: [], scroll: { up: false, down: true }, challenge: false };
  const chrome = {
    tabs: {
      async get(id) { calls.push({ command: 'get', id }); if (!tabs.has(id)) throw new Error('Unknown tab'); return { ...tabs.get(id) }; },
      async create({ url, active }) {
        const tab = { id: 2, windowId: 11, status: control.provisionalOpen ? 'loading' : 'complete', url: control.provisionalOpen ? 'about:blank' : url,
          ...(control.provisionalOpen ? { pendingUrl: url } : {}) };
        tabs.set(2, tab); calls.push({ command: 'create', active, url }); created.forEach((fn) => fn({ ...tab }));
        if (control.provisionalOpen) setTimeout(() => {
          tab.url = control.redirectsOnOpen ? 'https://other.test/redirect' : url; delete tab.pendingUrl; tab.status = 'complete';
          updated.forEach((fn) => fn(2, { url: tab.url, status: 'complete' }));
        }, 5);
        return { ...tab };
      },
      async update(id, change) { calls.push({ command: 'update', id, ...change }); const tab = tabs.get(id); Object.assign(tab, change); return { ...tab }; },
      async reload() { throw new Error('Fast mode must never reload'); },
      async sendMessage(id, message, options) {
        calls.push({ command: message.__hc, id, frameId: options.frameId });
        if (message.__hc === 'ping') { if (control.duringPing) await control.duringPing(); return { pong: control.pong }; }
        if (message.__hc === 'fast_snapshot') return { data: snapshot };
        if (message.__hc === 'fast_status') return { data: { pageChanged: false, navigated: false, challenge: false } };
        if (message.__hc === 'fast_verify') return { data: { verified: true, checks: [{ index: 0, passed: true, actualValue: 'must-not-leave' }] } };
        if (message.__hc === 'fast_abort') return { data: { aborted: true } };
        if (message.__hc === 'fast_act') {
          if (control.actionThrows) throw new Error('secret bearer provider-body');
          if (control.afterAction) await control.afterAction();
          return { data: { pageChanged: false, navigated: false, note: 'must-not-leave', text: 'must-not-leave' } };
        }
        throw new Error('Unexpected content command');
      },
      onCreated: { addListener(fn) { created.push(fn); } }, onUpdated: { addListener(fn) { updated.push(fn); } },
    },
    scripting: { async executeScript(args) { calls.push({ command: 'inject', args }); if (control.duringInjection) await control.duringInjection(); if (control.injectionFails) throw new Error('Cannot inject secret'); } },
  };
  const context = vm.createContext({ chrome, fastRuns: new Map(), fastTabWatches: new Map(), fastCanceledRuns: new Set(),
    CRED_URL, URL, setTimeout, clearTimeout, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitForReady: async (id, options) => { calls.push({ command: 'ready', id, ...options }); } });
  vm.runInContext(`${block}\nglobalThis.api = { fastOpen, fastObserve, fastPerform, fastAbortRun };`, context);
  const api = Object.fromEntries(Object.entries(context.api).map(([key, fn]) => [key, async (...args) => JSON.parse(JSON.stringify(await fn(...args)))]));
  return { tabs, calls, created, updated, config, control, api };
}

test('fast background observes with explicit frame 0 and never injects marker or runs manual effects', async () => {
  const h = harness(); const result = await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  assert.equal(result.snapshotId, 's1'); assert.equal(result.tabId, 1);
  assert(h.calls.filter((call) => call.command.startsWith('fast_') || call.command === 'ping').every((call) => call.frameId === 0));
  assert.equal(h.calls.some((call) => ['locate', 'click', 'effect', 'reload'].includes(call.command)), false);
});

test('failed content injection never reloads the tab or retries an action', async () => {
  const h = harness(); h.control.pong = false; h.control.injectionFails = true;
  const result = await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  assert.equal(result.blockedReason, 'content-unavailable');
  assert.equal(h.calls.filter((call) => call.command === 'inject').length, 1);
  assert.equal(h.calls.filter((call) => call.command === 'fast_snapshot').length, 0);
  assert.deepEqual(Array.from(h.calls.find((call) => call.command === 'inject').args.target.frameIds), [0]);
});

test('background abort during injection prevents queued action dispatch', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  h.control.pong = false;
  h.control.duringInjection = async () => { await h.api.fastAbortRun({ runId: h.config.runId }, 1); };
  const result = await h.api.fastPerform({ ...h.config, operation: 'CLICK', ref: 'e1', snapshotId: 's1', expectedUrl: 'https://example.test/start' }, 1);
  assert.equal(result.blockedReason, 'aborted'); assert.equal(h.calls.filter((call) => call.command === 'fast_act').length, 0);
});

test('new tabs during model delay block further cloud observation and are never followed', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  h.created.forEach((fn) => fn({ id: 3, openerTabId: 1, windowId: 11, url: 'https://other.test/new' }));
  const before = h.calls.length;
  const result = await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  assert.equal(result.blockedReason, 'new-tab-opened');
  assert.equal(h.calls.slice(before).some((call) => call.command === 'fast_snapshot'), false);
  assert.equal(h.calls.some((call) => call.id === 3), false);
});

test('an unrelated user tab in the same window does not interrupt the pinned run', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  h.created.forEach((fn) => fn({ id: 3, windowId: 11, url: 'https://other.test/user-tab' }));
  const result = await h.api.fastObserve(h.config, 1, 'fast_status');
  assert.equal(result.blockedReason, undefined);
});

test('cross-domain bounce remains blocked after returning to original URL', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  h.updated.forEach((fn) => fn(1, { url: 'https://other.test/redirect' }));
  h.updated.forEach((fn) => fn(1, { url: 'https://example.test/start' }));
  assert.equal((await h.api.fastObserve(h.config, 1, 'fast_status')).blockedReason, 'domain-out-of-scope');
});

test('background permits same-domain pages regardless of business semantics', async () => {
  const h = harness(); h.tabs.get(1).url = 'https://example.test/settings/api-keys';
  const result = await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  assert.equal(result.blockedReason, undefined); assert.equal(h.calls.some((call) => call.command === 'fast_snapshot'), true);
});

test('ambiguous action failure has sanitized output and a sticky no-replay stop', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot'); h.control.actionThrows = true;
  const params = { ...h.config, operation: 'CLICK', ref: 'e1', snapshotId: 's1', expectedUrl: 'https://example.test/start' };
  const first = await h.api.fastPerform(params, 1); const second = await h.api.fastPerform(params, 1);
  assert.equal(first.blockedReason, 'execution-unknown'); assert.equal(second.blockedReason, 'execution-unknown');
  assert.equal(JSON.stringify(first).includes('secret'), false); assert.equal(h.calls.filter((call) => call.command === 'fast_act').length, 1);
});

test('action receipts and verification omit any raw content or actual values', async () => {
  const h = harness(); await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  const receipt = await h.api.fastPerform({ ...h.config, operation: 'CLICK', ref: 'e1', snapshotId: 's1', expectedUrl: 'https://example.test/start' }, 1);
  assert.equal(JSON.stringify(receipt).includes('must-not-leave'), false);
  const verification = await h.api.fastObserve({ ...h.config, assertions: [{ state: 'ready' }] }, 1, 'fast_verify');
  assert.deepEqual(verification, { verified: true, checks: [{ index: 0, passed: true }], tabId: 1 });
});

test('run IDs retain immutable domains and deadlines, and unknown run actions never dispatch', async () => {
  const h = harness();
  assert.equal((await h.api.fastPerform(h.config, 1)).blockedReason, 'unknown-run');
  await h.api.fastObserve(h.config, 1, 'fast_snapshot');
  assert.equal((await h.api.fastObserve({ ...h.config, allowedDomains: ['example.test', 'other.test'] }, 1, 'fast_snapshot')).blockedReason, 'run-config-changed');
  assert.equal((await h.api.fastObserve({ ...h.config, deadline: h.config.deadline + 1 }, 1, 'fast_snapshot')).blockedReason, 'run-config-changed');
});

test('explicit initial URL opens an active tab so dynamic pages can render', async () => {
  const h = harness(); h.control.provisionalOpen = true;
  const result = await h.api.fastOpen({ ...h.config, url: 'https://example.test/start?filter=one#panel' });
  assert.deepEqual(result, { tabId: 2, url: 'https://example.test/start' });
  assert.equal(h.calls.find((call) => call.command === 'create').active, true);
  assert.deepEqual(h.calls.find((call) => call.command === 'ready'), { command: 'ready', id: 2, hardCap: 5000, quiet: 800 });
  assert.equal(h.calls.some((call) => call.command === 'fast_snapshot'), false);
});

test('initial URL setup rejects out-of-scope destinations and detects redirects before content reads', async () => {
  const h = harness();
  assert.equal((await h.api.fastOpen({ ...h.config, url: 'https://other.test/start' })).blockedReason, 'domain-out-of-scope');
  assert.equal(h.calls.length, 0);
  h.control.provisionalOpen = true; h.control.redirectsOnOpen = true;
  const result = await h.api.fastOpen({ ...h.config, url: 'https://example.test/start' });
  assert.equal(result.blockedReason, 'domain-out-of-scope');
  assert.equal(h.calls.some((call) => call.command === 'fast_snapshot'), false);
});

test('explicit abort before initial setup prevents opening or navigating a tab', async () => {
  const h = harness(); await h.api.fastAbortRun({ runId: h.config.runId });
  const result = await h.api.fastOpen({ ...h.config, url: 'https://example.test/start' });
  assert.equal(result.blockedReason, 'aborted'); assert.equal(h.calls.length, 0);
});
