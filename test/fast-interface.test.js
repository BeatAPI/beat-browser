import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseRunArgs, runCli } from '../src/fast-agent/cli.js';
import { BROWSER_TASK_TOOL, cloudConsentNotice, handleBrowserTask } from '../src/fast-agent/task.js';
import { getToolList } from '../src/mcp-server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASIC = ['--url', 'https://example.com/docs', '--goal', 'Inspect the public documentation'];
const task = (overrides = {}) => ({ url: BASIC[1], goal: BASIC[3], cloudConsent: true, ...overrides });
const body = (response) => JSON.parse(response.content[0].text);
const stream = () => ({ text: '', write(value) { this.text += value; } });

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-fast-interface-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('default MCP tools exactly preserve the pinned baseline schemas and descriptions', () => {
  const tools = getToolList();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'snapshot', 'navigate', 'click', 'type', 'select', 'fill', 'key', 'read_text',
    'screenshot', 'tabs', 'wait', 'network', 'fetch', 'scroll', 'download', 'upload',
    'query', 'act', 'ask', 'status', 'eval', 'learnings', 'reload',
  ]);
  // Independently computed from base 7f674cff63d28b18371da2db5a393c470e4bd72e.
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    '00590d166e65b6926d05b94ac41cdb9d13a8371a6bfb159c92255fae63eff3d3');
  assert.deepEqual(getToolList({ fastAgentEnabled: true }).slice(0, -1), tools);
  assert.equal(getToolList({ fastAgentEnabled: true }).at(-1).name, 'browser_task');
  assert.equal(getToolList({ fastAgentEnabled: '1' }).length, 23);
});

test('optional task schema exposes no credential, model, code, tab or output-path overrides', () => {
  const schema = BROWSER_TASK_TOOL.inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['cloudConsent', 'url', 'goal']);
  assert.deepEqual(schema.properties.cloudConsent.enum, [true]);
  for (const field of ['apiKey', 'baseUrl', 'model', 'textModel', 'key', 'eval', 'expr', 'selector', 'tabId', 'tracePath']) {
    assert.equal(schema.properties[field], undefined);
  }
});

test('CLI parses explicit opt-in, bounded files and repeatable exact domains', (t) => {
  const dir = tempDir(t);
  const files = [
    ['domains.json', ['docs.example.com', 'static.example.com']],
    ['assertions.json', [{ textContains: 'Documentation ready' }, { selector: '#ready', checked: true }]],
    ['inputs.json', [{ name: 'Search', role: 'textbox', text: 'browser' }]],
  ];
  for (const [filename, value] of files) fs.writeFileSync(path.join(dir, filename), JSON.stringify(value));
  const options = parseRunArgs([...BASIC, '--enable-fast-agent', '--max-steps', '8',
    '--max-model-calls', '12', '--timeout-ms', '45000', '--allow-domain', 'Example.COM',
    '--allow-domain', 'docs.example.com', '--allowlist', path.join(dir, 'domains.json'),
    '--click-name', 'Reply', '--click-name', 'Submit',
    '--assertions', path.join(dir, 'assertions.json'), '--inputs', path.join(dir, 'inputs.json'),
    '--trace', path.join(dir, 'new-trace.jsonl'), '--ask-on-block', '--allow-text-helper']);
  assert.equal(options.enabled, true);
  assert.equal(options.allowTextHelper, true);
  assert.equal(options.askOnBlock, true);
  assert.equal(options.maxSteps, 8);
  assert.equal(options.maxModelCalls, 12);
  assert.equal(options.timeoutMs, 45000);
  assert.deepEqual(options.allowedDomains, ['example.com', 'docs.example.com', 'static.example.com']);
  assert.deepEqual(options.assertions, files[1][1]);
  assert.deepEqual(options.inputs, files[2][1]);
  assert.deepEqual(options.clickNames, ['Reply', 'Submit']);
});

const invalidArgs = [
  ['--unknown'], ['--model', 'injected'], ['--goal'], ['--trace'],
  ['--max-steps', '0'], ['--max-steps', '101'], ['--max-model-calls', '201'],
  ['--timeout-ms', '600001'], ['--max-steps', '1.5'], ['--max-steps', 'NaN'],
  ['--max-steps', '2e1'], ['--max-steps', '9007199254740992'],
  ['--dry-run', '--dry-run'], ['--enable-fast-agent', 'false'],
  ['--allow-domain', '*.example.com'], ['--allow-domain', 'https://example.org'],
  ['--allow-domain', 'example.org:443'], ['--max-steps=2'],
  ['--click-name', 'Reply', '--click-name', 'Reply'],
];
for (const [index, flags] of invalidArgs.entries()) {
  test(`invalid CLI option case ${index + 1} stops before runner invocation`, async () => {
    const stdout = stream(), stderr = stream();
    let calls = 0;
    const exitCode = await runCli([...BASIC, ...flags], {
      stdout, stderr, signalSource: new EventEmitter(), runTaskImpl: async () => { calls++; },
    });
    assert.equal(calls, 0);
    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(stdout.text).status, 'error');
    assert.equal(stderr.text, '');
  });
}

test('invalid, oversized and symlinked task files fail without echoing file contents', async (t) => {
  const dir = tempDir(t);
  const invalid = path.join(dir, 'invalid.json');
  const huge = path.join(dir, 'huge.json');
  const object = path.join(dir, 'object.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(invalid, '{"DO_NOT_ECHO_PRIVATE_VALUE":');
  fs.writeFileSync(huge, ' '.repeat(65537));
  fs.writeFileSync(object, '{"name":"not an array"}');
  fs.symlinkSync(object, link);
  for (const filename of [invalid, huge, object, link, dir]) {
    const stdout = stream();
    let calls = 0;
    const exitCode = await runCli([...BASIC, '--inputs', filename], {
      stdout, stderr: stream(), signalSource: new EventEmitter(), runTaskImpl: async () => { calls++; },
    });
    assert.equal(exitCode, 1);
    assert.equal(calls, 0);
    assert.doesNotMatch(stdout.text, /DO_NOT_ECHO_PRIVATE_VALUE/);
    assert.equal(stdout.text.includes(dir), false);
  }
});

test('CLI dry run has zero bridge/model work, no trace and no key read', async (t) => {
  const dir = tempDir(t), stdout = stream(), stderr = stream();
  const env = new Proxy({}, { get() { assert.fail('dry run must not inspect provider environment'); } });
  const forbidden = new Proxy({}, { get() { assert.fail('dry run must not use browser or model dependencies'); } });
  const tracePath = path.join(dir, 'must-not-exist.jsonl');
  const exitCode = await runCli([...BASIC, '--dry-run', '--trace', tracePath], {
    stdout, stderr, signalSource: new EventEmitter(),
    dependencies: { env, bridge: forbidden, client: forbidden, adapter: forbidden, fetchImpl: () => assert.fail('network call') },
  });
  const result = JSON.parse(stdout.text);
  assert.equal(exitCode, 0);
  assert.equal(result.status, 'dry_run');
  assert.equal(result.verified, false);
  assert.equal(result.tracePath, null);
  assert.deepEqual(result.allowedDomains, ['example.com']);
  assert.ok(result.operations.includes('SELECT'));
  assert.equal(result.metrics.modelCalls, 0);
  assert.equal(result.metrics.browserProtocolCalls, 0);
  assert.equal(fs.existsSync(tracePath), false);
  assert.equal(stderr.text, '');
});

test('CLI enabled task with missing key fails before any browser or trace work', async (t) => {
  const dir = tempDir(t), stdout = stream(), stderr = stream();
  const tracePath = path.join(dir, 'must-not-exist.jsonl');
  const forbidden = new Proxy({}, { get() { assert.fail('missing key must not use browser'); } });
  const exitCode = await runCli([...BASIC, '--enable-fast-agent', '--trace', tracePath], {
    stdout, stderr, signalSource: new EventEmitter(), dependencies: { env: {}, bridge: forbidden, adapter: forbidden },
  });
  const result = JSON.parse(stdout.text);
  assert.equal(exitCode, 1);
  assert.equal(result.blockedReason, 'MISSING_API_KEY');
  assert.equal(result.metrics.browserProtocolCalls, 0);
  assert.equal(fs.existsSync(tracePath), false);
  assert.match(stderr.text, /Cloud consent/);
  assert.match(stderr.text, /best effort/);
});

test('CLI without explicit opt-in stays disabled even when provider configuration exists', async () => {
  const stdout = stream(), stderr = stream();
  const forbidden = new Proxy({}, { get() { assert.fail('disabled task must not inspect providers or browser'); } });
  const exitCode = await runCli(BASIC, {
    stdout, stderr, signalSource: new EventEmitter(), dependencies: { env: forbidden, bridge: forbidden, adapter: forbidden },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout.text).status, 'disabled');
  assert.equal(JSON.parse(stdout.text).metrics.modelCalls, 0);
  assert.equal(stderr.text, '');
});

for (const signalName of ['SIGINT', 'SIGTERM']) {
test(`CLI ${signalName} is forwarded and signal listeners are cleaned up`, async () => {
  const stdout = stream(), stderr = stream(), signalSource = new EventEmitter();
  const promise = runCli([...BASIC, '--enable-fast-agent'], {
    stdout, stderr, signalSource,
    runTaskImpl: async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      assert.equal(signal.aborted, true);
      return { status: 'aborted', verified: false, blockedReason: 'ABORTED' };
    },
  });
  signalSource.emit(signalName);
  assert.equal(await promise, 1);
  assert.equal(JSON.parse(stdout.text).status, 'aborted');
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
}

test('unexpected runner errors are not printed verbatim', async () => {
  const stdout = stream();
  await runCli([...BASIC, '--enable-fast-agent'], {
    stdout, stderr: stream(), signalSource: new EventEmitter(),
    runTaskImpl: async () => { throw new Error('credential-like-private-content'); },
  });
  assert.doesNotMatch(stdout.text, /credential-like-private-content/);
  assert.equal(JSON.parse(stdout.text).blockedReason, 'INTERNAL');
});

test('cloud notice shows destination origin only and describes helper consent', () => {
  const notice = cloudConsentNotice(true, { BEATAPI_BASE_URL: 'https://api.example.test/v1?private=secret#token' });
  assert.match(notice, /https:\/\/api.example.test/);
  assert.match(notice, /explicitly configured text model/);
  assert.doesNotMatch(notice, /private=secret|#token/);
  assert.doesNotMatch(cloudConsentNotice(false, { BEATAPI_BASE_URL: 'https://user:private-secret@example.test' }), /private-secret/);
});

test('MCP gating and unsupported request fields never invoke the runner or bridge', async () => {
  let calls = 0;
  const runTaskImpl = async () => { calls++; assert.fail('gating must happen first'); };
  const bridge = new Proxy({}, { get() { assert.fail('gating must not use browser'); } });
  const options = { bridge, runTaskImpl, stderr: stream() };
  assert.equal(body(await handleBrowserTask(task(), options)).blockedReason, 'FAST_AGENT_DISABLED');
  assert.equal(body(await handleBrowserTask(task({ cloudConsent: false }), { ...options, enabled: true })).blockedReason, 'CLOUD_CONSENT_REQUIRED');
  assert.equal(body(await handleBrowserTask(task({ cloudConsent: 'true' }), { ...options, enabled: true })).blockedReason, 'CLOUD_CONSENT_REQUIRED');
  for (const key of ['apiKey', 'model', 'baseUrl', 'eval', 'tracePath', 'tabId']) {
    assert.equal(body(await handleBrowserTask(task({ [key]: 'forbidden' }), { ...options, enabled: true })).blockedReason, 'INVALID_TASK');
  }
  assert.equal(body(await handleBrowserTask(task({ maxSteps: 101 }), { ...options, enabled: true })).blockedReason, 'INVALID_TASK');
  assert.equal(body(await handleBrowserTask(task({ assertions: [{ expr: 'dangerous()' }] }), { ...options, enabled: true })).blockedReason, 'INVALID_TASK');
  assert.equal(calls, 0);
});

test('MCP forwards cancellation, reuses the bridge and excludes full-page results', async () => {
  const controller = new AbortController(), bridge = {}, stderr = stream();
  const result = await handleBrowserTask(task(), {
    enabled: true, bridge, signal: controller.signal, env: {}, stderr,
    runTaskImpl: async (options, dependencies) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(options.enabled, true);
      assert.equal(dependencies.bridge, bridge);
      return { status: 'completion_candidate', verified: false, summary: 'Review assertions.',
        tabId: 9, metrics: { modelCalls: 1 }, page: { text: 'PRIVATE_FULL_PAGE' }, snapshot: 'PRIVATE_SNAPSHOT' };
    },
  });
  assert.equal(body(result).tabId, 9);
  assert.equal(body(result).verified, false);
  assert.doesNotMatch(result.content[0].text, /PRIVATE_FULL_PAGE|PRIVATE_SNAPSHOT/);
  assert.match(stderr.text, /Cloud consent/);
});

for (const enabled of [false, true]) {
  test(`actual MCP stdio startup preserves offline gating with fast enabled=${enabled}`, { timeout: 10000 }, async (t) => {
    const guard = `
      import { BridgeClient } from './src/lib/rpc.js';
      BridgeClient.prototype.connect = async () => { throw new Error('OFFLINE_BRIDGE_FORBIDDEN'); };
      globalThis.fetch = async () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
      const { startMcpServer } = await import('./src/mcp-server.js');
      await startMcpServer();
    `;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--input-type=module', '-e', guard],
      cwd: ROOT,
      env: { ...process.env, BEATAPI_API_KEY: '', BEAT_BROWSER_FAST_AGENT: enabled ? '1' : '0' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'offline-interface-test', version: '1.0.0' });
    t.after(async () => { await client.close(); });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, enabled ? 24 : 23);
    assert.equal(listed.tools.some((tool) => tool.name === 'browser_task'), enabled);
    const response = await client.callTool({ name: 'browser_task', arguments: task({ dryRun: true }) });
    const result = body(response);
    assert.equal(result.status, enabled ? 'dry_run' : 'disabled');
    if (enabled) {
      assert.deepEqual(result.allowedDomains, ['example.com']);
      assert.equal(result.metrics.modelCalls, 0);
      assert.equal(result.metrics.browserProtocolCalls, 0);
      const missing = body(await client.callTool({ name: 'browser_task', arguments: task({ cloudConsent: false }) }));
      assert.equal(missing.blockedReason, 'CLOUD_CONSENT_REQUIRED');
    }
  });
}
