import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { createBridgeAdapter } from '../src/fast-agent/transport.js';
import { runTask, abortable } from '../src/fast-agent/runner.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const context = () => ({ runId: 'offline-run-0001', deadline: Date.now() + 10000,
  allowedDomains: ['example.com'], tabId: 5, signal: new AbortController().signal });

test('real extension reason vocabulary is normalized at the transport boundary', async () => {
  const expected = { 'stale-snapshot': 'STALE_SNAPSHOT', 'domain-out-of-scope': 'DOMAIN_BLOCKED',
    'execution-unknown': 'UNCERTAIN_ACTION', 'challenge': 'PAGE_CHALLENGE',
    'new-tab-opened': 'NEW_TAB', 'deadline-exceeded': 'TIMEOUT', 'aborted': 'ABORTED',
    'sensitive-page': 'RISK_BLOCKED', 'secret provider body': 'BROWSER_ERROR' };
  for (const [reason, code] of Object.entries(expected)) {
    const calls = [];
    const adapter = createBridgeAdapter({ bridge: { ws: {}, extensionOnline: true,
      call: async (command, params, options) => { calls.push({ command, params, options }); return { blockedReason: reason, pageChanged: false }; } } });
    const result = await adapter.execute({ operation: 'CLICK', ref: 'e1', snapshotId: 's1' }, context());
    assert.equal(result.blockedReason, code);
    assert.equal(calls[0].command, 'fast_act');
    assert.equal(calls[0].params.runId, 'offline-run-0001');
    assert.equal(JSON.stringify(calls).includes('BEATAPI'), false);
    adapter.close();
  }
});

test('runner plus real transport consumes raw stale rejection and requests a new decision', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-fast-wire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sequence = 0, attempts = 0, effects = 0;
  const bridge = { ws: {}, extensionOnline: true, async call(command, params) {
    if (command === 'fast_open') return { tabId: 5, url: 'https://example.com/' };
    if (command === 'fast_status' || command === 'fast_abort') return {};
    if (command === 'fast_snapshot') return { snapshotId: `s${++sequence}`, url: 'https://example.com/',
      title: 'Fixture', visibleText: effects ? 'Visible details' : '', scroll: { up: false, down: false },
      elements: [{ ref: 'e1', role: 'button', name: 'Details', tagName: 'BUTTON', inputType: 'button',
        visible: true, disabled: false, readOnly: false, sensitive: false, risk: null, operations: ['CLICK'] }] };
    if (command === 'fast_act') {
      attempts++;
      if (attempts === 1) return { blockedReason: 'stale-snapshot', pageChanged: false };
      assert.equal(params.snapshotId, 's2'); effects++; return { pageChanged: true };
    }
    if (command === 'fast_verify') return { verified: effects > 0, checks: [{ index: 0, passed: effects > 0 }] };
    throw new Error('Unexpected command');
  } };
  const client = { async decide({ questions }) {
    const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      const ids = Object.keys(q.criteria), choice = key === 'operation' ? 'CLICK' : ids[0];
      return [key, { type: 'choice', choice, confidence: 0.95,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])) }];
    }));
    return { answers };
  } };
  const result = await runTask({ enabled: true, url: 'https://example.com/', goal: 'Open details',
    assertions: [{ textContains: 'Visible details' }], tracePath: path.join(dir, 'trace.jsonl') }, { bridge, client });
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.staleDecisions, 1);
  assert.equal(result.metrics.modelCalls, 2);
  assert.equal(effects, 1);
});

test('abortable consumes an already-started rejection when cancellation is synchronous', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortable(Promise.reject(new Error('late private transport failure')), controller.signal), { code: 'ABORTED' });
  // Node's test runner reports an unhandled rejection after this test as failure.
  await wait(0);
});

async function peer(port, role, label, autoReply = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`,
    role === 'extension' ? { headers: { Origin: 'chrome-extension://offline-test-extension' } } : {});
  const messages = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    messages.push(message);
    if (role === 'extension' && message.type === 'cmd' && autoReply) {
      socket.send(JSON.stringify({ type: 'res', id: message.id, __k: message.__k, ok: true, data: { extension: label } }));
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify(role === 'extension'
    ? { type: 'hello', role, version: '1.2.0', chrome: 'offline-test', instanceId: label }
    : { type: 'hello', role, token: 'offline-bridge-token', client: 'offline-test', sessionId: 'offline-test-session' }));
  const until = Date.now() + 1000;
  while (!messages.some((m) => m.type === 'welcome') && Date.now() < until) await wait(2);
  assert.ok(messages.some((m) => m.type === 'welcome'));
  return { socket, messages };
}

async function sendCommand(agent, command, id, params = {}) {
  agent.socket.send(JSON.stringify({ type: 'cmd', id, cmd: command, params, timeout: 1000 }));
  const until = Date.now() + 1500;
  while (!agent.messages.some((m) => m.type === 'res' && m.id === id) && Date.now() < until) await wait(2);
  const result = agent.messages.find((m) => m.type === 'res' && m.id === id);
  assert.ok(result, `No response to ${command}`);
  return result;
}

test('local WebSocket bridge pins a fast run and its cancellation to one Chrome', async (t) => {
  const server = startBridge({ port: 0, writeInfo: false, token: 'offline-bridge-token', auditFn: () => {} });
  t.after(() => server.close());
  await server.ready;
  const port = server.wss.address().port;
  const a = await peer(port, 'extension', 'Chrome-A');
  const agent = await peer(port, 'agent');
  const scope = { runId: 'offline-pinned-run', allowedDomains: ['example.com'], deadline: Date.now() + 10000 };
  assert.equal((await sendCommand(agent, 'fast_open', 'one', scope)).data.extension, 'Chrome-A');
  const b = await peer(port, 'extension', 'Chrome-B');
  assert.equal((await sendCommand(agent, 'fast_act', 'two', scope)).data.extension, 'Chrome-A');
  assert.equal((await sendCommand(agent, 'fast_abort', 'three', { runId: scope.runId })).data.extension, 'Chrome-A');
  assert.equal(b.messages.some((m) => m.type === 'cmd' && m.cmd.startsWith('fast_')), false);
  const canceled = await sendCommand(agent, 'fast_act', 'four', scope);
  assert.equal(canceled.ok, false);
  assert.equal(canceled.error.code, 'ABORTED');
  // Existing manual commands continue to use their original extension selection.
  b.socket.send(JSON.stringify({ type: 'pong' }));
  await wait(5);
  assert.equal((await sendCommand(agent, 'snapshot', 'manual')).data.extension, 'Chrome-B');
  assert.ok(a.messages.some((m) => m.cmd === 'fast_abort'));
});

test('bounded commands fail immediately without an extension and are never replayed', async (t) => {
  const server = startBridge({ port: 0, writeInfo: false, token: 'offline-bridge-token', auditFn: () => {} });
  t.after(() => server.close());
  await server.ready;
  const port = server.wss.address().port;
  const agent = await peer(port, 'agent');
  const result = await sendCommand(agent, 'fast_open', 'offline', { runId: 'offline-no-replay', deadline: Date.now() + 10000 });
  assert.equal(result.error.code, 'NO_EXTENSION');
  const extension = await peer(port, 'extension', 'Chrome-late');
  await wait(20);
  assert.equal(extension.messages.some((m) => m.type === 'cmd'), false);
});

test('a second Chrome cannot supply the receipt for a pinned fast command', async (t) => {
  const server = startBridge({ port: 0, writeInfo: false, token: 'offline-bridge-token', auditFn: () => {} });
  t.after(() => server.close());
  await server.ready;
  const port = server.wss.address().port;
  const a = await peer(port, 'extension', 'Owner-Chrome', false);
  const agent = await peer(port, 'agent');
  agent.socket.send(JSON.stringify({ type: 'cmd', id: 'pending-one', cmd: 'fast_open',
    params: { runId: 'offline-receipt-owner', deadline: Date.now() + 10000 }, timeout: 1000 }));
  const until = Date.now() + 1000;
  while (!a.messages.some((m) => m.type === 'cmd') && Date.now() < until) await wait(2);
  const pending = a.messages.find((m) => m.type === 'cmd');
  assert.ok(pending);
  const b = await peer(port, 'extension', 'Other-Chrome');
  b.socket.send(JSON.stringify({ type: 'res', id: pending.id, __k: pending.__k, ok: true, data: { forged: true } }));
  await wait(20);
  assert.equal(agent.messages.some((m) => m.type === 'res' && m.id === pending.id), false);
  a.socket.send(JSON.stringify({ type: 'res', id: pending.id, __k: pending.__k, ok: true, data: { owner: true } }));
  await wait(20);
  assert.equal(agent.messages.find((m) => m.type === 'res' && m.id === pending.id)?.data.owner, true);
});
