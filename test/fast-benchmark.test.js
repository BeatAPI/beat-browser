import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { runBenchmark, loadFixtureTasks, validateRecord, summarizeRecords, aggregateRecords }
  from '../scripts/benchmark-fast-agent.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'benchmark-fast-agent.mjs');

function externalRecord(overrides = {}) {
  return {
    schemaVersion: 1, evidenceMode: 'live-external', mode: 'A', taskId: 'measured-task', iteration: 1,
    outcome: 'completed', taskSuccess: true, verified: true, blocked: false, unverified: false,
    escalated: false, expectedOutcomeMatched: null, blockedReason: null,
    latencyMs: 12, modelCalls: 2, inputTokens: 5, retries: 0, staleDecisions: 0,
    safetyEscalations: 0, protocolCalls: 8, browserActions: 1,
    measurement: { latency: 'external-wall-clock', model: 'external-model-logs',
      browser: 'external-protocol-logs', tokens: 'provider-reported', modelLatencyRepresentative: true },
    ...overrides,
  };
}

test('all A/B/C fixture outcomes repeat offline through the real fast runner without fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('Unexpected network request'); };
  let report;
  try { report = await runBenchmark({ iterations: 2 }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(fetchCalls, 0);
  assert.equal(report.evidenceMode, 'offline-mock');
  assert.equal(report.records.length, 54);
  assert.equal(report.summaries.length, 3);
  assert.equal(report.records.every(row => row.expectedOutcomeMatched), true,
    JSON.stringify(report.records.filter(row => !row.expectedOutcomeMatched)));
  assert.equal(report.records.every(row => row.inputTokens === null), true);
  assert.equal(report.records.every(row => row.measurement.modelLatencyRepresentative === false), true);
  assert.equal(report.summaries.every(group => group.inputTokens.total === null && group.inputTokens.coverage === 0), true);

  const rows = (task, mode) => report.records.filter(row => row.taskId === task && (!mode || row.mode === mode));
  for (const row of rows('stale-once', 'B')) {
    assert.equal(row.modelCalls, 2);
    assert.equal(row.staleDecisions, 1);
    assert.equal(row.retries, 1);
    assert.equal(row.browserActions, 1);
  }
  for (const row of rows('sensitive-send')) {
    assert.equal(row.blocked, true);
    assert.equal(row.taskSuccess, false);
    assert.equal(row.verified, false);
    assert.equal(row.browserActions, 0);
    assert.equal(row.expectedOutcomeMatched, true);
  }
  for (const row of rows('no-effect')) {
    assert.equal(row.browserActions, 1);
    assert.equal(row.retries, 0);
    assert.equal(row.blocked, true);
  }
  for (const row of rows('domain-drift', 'B')) {
    assert.equal(row.blockedReason, 'DOMAIN_BLOCKED');
    assert.equal(row.modelCalls, 1);
  }
  for (const row of rows('low-confidence', 'B')) assert.equal(row.browserActions, 0);
  for (const row of rows('low-confidence', 'C')) {
    assert.equal(row.verified, true);
    assert.equal(row.escalated, true);
    assert.equal(row.safetyEscalations, 1);
    assert.equal(row.browserActions, 1);
    assert.equal(row.modelCalls, 4);
  }
  for (const row of rows('unverified-done')) {
    assert.equal(row.unverified, true);
    assert.equal(row.verified, false);
    assert.equal(row.taskSuccess, true);
  }
});

test('median, nearest-rank p95 and token coverage do not treat unknown usage as zero', () => {
  const records = Array.from({ length: 20 }, (_, index) => externalRecord({ iteration: index + 1, latencyMs: index + 1 }));
  records[0].inputTokens = null;
  records[0].measurement.tokens = 'unavailable';
  const summary = summarizeRecords(records);
  assert.equal(summary.latencyMs.median, 10.5);
  assert.equal(summary.latencyMs.p95, 19);
  assert.equal(summary.inputTokens.total, null);
  assert.equal(summary.inputTokens.knownTotal, 95);
  assert.equal(summary.inputTokens.coverage, 0.95);
  assert.equal(summary.modelCalls.total, 40);
  assert.equal(summary.rates.expectedOutcomeMatched, null);
  assert.equal(summarizeRecords([externalRecord({ inputTokens: 0 })]).inputTokens.total, 0);
});

test('schema rejects forged offline token measurements and inconsistent outcomes', () => {
  const offline = externalRecord({ evidenceMode: 'offline-mock', inputTokens: null,
    measurement: { latency: 'local-harness-clock', model: 'mock-client-calls',
      browser: 'simulated-adapter', tokens: 'unavailable', modelLatencyRepresentative: false } });
  assert.equal(validateRecord(offline).inputTokens, null);
  assert.throws(() => validateRecord({ ...offline, inputTokens: 5 }), /INVALID_MEASUREMENT_PROVENANCE/);
  assert.throws(() => validateRecord({ ...offline,
    measurement: { ...offline.measurement, modelLatencyRepresentative: true } }), /INVALID_MEASUREMENT_PROVENANCE/);
  for (const change of [
    { outcome: 'completed', verified: false }, { blocked: true }, { taskSuccess: false },
    { unverified: true },
  ]) assert.throws(() => validateRecord(externalRecord(change)), /INCONSISTENT_BENCHMARK_OUTCOME/);
  for (const change of [
    { modelCalls: -1 }, { modelCalls: 0.5 }, { latencyMs: Infinity }, { inputTokens: undefined },
    { taskId: '../file' }, { blockedReason: 'untrusted page body' }, { expectedOutcomeMatched: undefined },
  ]) assert.throws(() => validateRecord(externalRecord(change)), /INVALID_BENCHMARK_RECORD/);
});

test('different evidence and mode groups remain separate; duplicate trials are rejected', () => {
  const a = externalRecord();
  const b = externalRecord({ mode: 'B', latencyMs: 30 });
  const offline = externalRecord({ evidenceMode: 'offline-mock', inputTokens: null,
    measurement: { latency: 'local-harness-clock', model: 'mock-client-calls',
      browser: 'simulated-adapter', tokens: 'unavailable', modelLatencyRepresentative: false } });
  const groups = aggregateRecords([a, b, offline]);
  assert.equal(groups.length, 3);
  assert.equal(groups.every(group => group.runs === 1), true);
  assert.throws(() => summarizeRecords([a, b]), /MIXED_MEASUREMENT_GROUP/);
  assert.throws(() => aggregateRecords([a, { ...a }]), /DUPLICATE_BENCHMARK_RECORD/);
  assert.throws(() => aggregateRecords([]), /INVALID_RECORD_SET/);
});

test('fixture descriptions are unique and the standalone page script parses', async () => {
  const tasks = await loadFixtureTasks();
  assert.equal(new Set(tasks.map(task => task.id)).size, 9);
  const html = await readFile(path.join(ROOT, 'test', 'fixtures', 'fast-agent.html'), 'utf8');
  assert.equal(/<script[^>]+src=|<link[^>]+href=/i.test(html), false);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('benchmark script passes syntax and executable single-task smoke checks', async () => {
  await exec(process.execPath, ['--check', SCRIPT], { cwd: ROOT });
  const { stdout, stderr } = await exec(process.execPath, [SCRIPT, '--iterations', '1', '--task', 'details'],
    { cwd: ROOT, maxBuffer: 1024 * 1024, timeout: 15000 });
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.records.length, 3);
  assert.equal(report.records.every(row => row.verified), true);
  assert.deepEqual(report.summaries.map(group => group.mode), ['A', 'B', 'C']);
});

test('external importer aggregates records, projects out unrelated data and rejects mock relabeling', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'beat-browser-import-test-'));
  const file = path.join(directory, 'records.json');
  const record = externalRecord({ unrelatedPrivateField: 'must not be copied' });
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [record] }));
    const { stdout } = await exec(process.execPath, [SCRIPT, '--input-records', file], { cwd: ROOT });
    const report = JSON.parse(stdout);
    assert.equal(report.evidenceMode, 'live-external');
    assert.equal(report.summaries[0].inputTokens.total, 5);
    assert.equal(stdout.includes('must not be copied'), false);
    assert.match(report.limitations[0], /not independently verified/);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: [{ ...record, evidenceMode: 'offline-mock' }] }));
    await assert.rejects(exec(process.execPath, [SCRIPT, '--input-records', file], { cwd: ROOT }),
      error => error.code === 1 && /INVALID_EXTERNAL_RECORDS/.test(error.stderr));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid bounds, unknown tasks and CLI flags fail before fixture execution', async () => {
  await assert.rejects(runBenchmark({ iterations: 0 }), /INVALID_ITERATIONS/);
  await assert.rejects(runBenchmark({ iterations: 101 }), /INVALID_ITERATIONS/);
  await assert.rejects(runBenchmark({ taskId: 'unknown' }), /UNKNOWN_TASK/);
  await assert.rejects(exec(process.execPath, [SCRIPT, '--provider', 'any'], { cwd: ROOT }),
    error => error.code === 1 && /INVALID_ARGUMENTS/.test(error.stderr));
});
