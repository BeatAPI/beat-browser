// [INPUT] Synthetic WebSocket peers and loopback bridge.
// [OUTPUT] Regression checks for malformed input and response ownership.
// [POS] Release transport boundary tests.
// [PROTOCOL] No browser profile, production bridge or credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBridge } from '../src/bridge.js';
import { tokenEquals } from '../src/lib/paths.js';
import { VERSION } from '../src/lib/version.js';

const until = async (predicate) => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected socket event did not arrive');
};
const peer = async (port, extension = false) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, extension
    ? { headers: { Origin: 'chrome-extension://synthetic-test' } } : {});
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw)));
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, messages };
};
const hello = (p, extension, instanceId = 'fixture') => p.socket.send(JSON.stringify(extension
  ? { type: 'hello', role: 'extension', version: VERSION, instanceId }
  : { type: 'hello', role: 'agent', token: 'synthetic-release-token' }));

test('token comparison rejects multibyte and malformed values without throwing', () => {
  assert.equal(tokenEquals('x'.repeat(64), 'x'.repeat(64)), true);
  assert.equal(tokenEquals(String.fromCodePoint(0x00e9).repeat(64), 'x'.repeat(64)), false);
  assert.equal(tokenEquals({}, 'x'.repeat(64)), false);
  assert.equal(tokenEquals(null, 'x'.repeat(64)), false);
});

test('malformed JSON values and invalid token lengths leave the shared bridge alive', async t => {
  const server = startBridge({ port: 0, writeInfo: false, token: 'synthetic-release-token', auditFn: () => {} });
  t.after(() => server.close());
  await server.ready;
  const port = server.wss.address().port;
  for (const invalid of [null, [], 42, 'hello', {}, { type: 'hello', role: 'agent', token: {} },
    { type: 'hello', role: 'agent', token: String.fromCodePoint(0x00e9).repeat(23) }]) {
    const p = await peer(port);
    const closed = new Promise(resolve => p.socket.once('close', resolve));
    p.socket.send(JSON.stringify(invalid));
    await closed;
  }
  const valid = await peer(port);
  hello(valid, false);
  await until(() => valid.messages.some(m => m.type === 'welcome'));
  valid.socket.send(JSON.stringify({ type: 'ping' }));
  await until(() => valid.messages.some(m => m.type === 'pong'));
});

test('Normal-mode response belongs to the extension that received the command', async t => {
  const server = startBridge({ port: 0, writeInfo: false, token: 'synthetic-release-token', auditFn: () => {} });
  t.after(() => server.close());
  await server.ready;
  const port = server.wss.address().port;
  const owner = await peer(port, true);
  hello(owner, true, 'owner');
  await until(() => owner.messages.some(m => m.type === 'welcome'));
  const agent = await peer(port);
  hello(agent, false);
  await until(() => agent.messages.some(m => m.type === 'welcome'));
  agent.socket.send(JSON.stringify({ type: 'cmd', id: 'read', cmd: 'snapshot', params: {}, timeout: 2000 }));
  await until(() => owner.messages.some(m => m.type === 'cmd'));
  const command = owner.messages.find(m => m.type === 'cmd');
  const other = await peer(port, true);
  hello(other, true, 'other');
  await until(() => other.messages.some(m => m.type === 'welcome'));
  other.socket.send(JSON.stringify({ type: 'res', id: command.id, __k: command.__k, ok: true, data: 'forged' }));
  other.socket.send(JSON.stringify({ type: 'ping' }));
  await until(() => other.messages.some(m => m.type === 'pong'));
  assert.equal(agent.messages.some(m => m.type === 'res' && m.id === 'read'), false);
  owner.socket.send(JSON.stringify({ type: 'res', id: command.id, __k: command.__k, ok: true, data: 'owner' }));
  await until(() => agent.messages.some(m => m.type === 'res' && m.id === 'read'));
  assert.equal(agent.messages.find(m => m.type === 'res' && m.id === 'read').data, 'owner');
});
