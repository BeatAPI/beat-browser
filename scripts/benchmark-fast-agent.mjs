#!/usr/bin/env node
/** Offline fixtures and externally supplied measurements only. No provider calls. */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runTask } from '../src/fast-agent/runner.js';

const FIXTURE = new URL('../test/fixtures/fast-agent.html', import.meta.url);
const START_URL = 'https://fixture.example.test/fast-agent';
const MODES = ['A', 'B', 'C'];
const OUTCOMES = ['completed', 'blocked', 'completion_candidate', 'error', 'timeout', 'aborted'];
const COUNTERS = ['modelCalls', 'retries', 'staleDecisions', 'safetyEscalations', 'protocolCalls', 'browserActions'];
const FLAGS = ['taskSuccess', 'verified', 'blocked', 'unverified', 'escalated'];
const LIMITATIONS = [
  'Offline mocks exercise control flow and accounting, not real browser or model performance.',
  'Latency is local harness overhead; model latency is not representative.',
  'Model calls are mock function calls. Input tokens are unknown, not estimated.',
  'Mode A and hybrid outer escalation use declared scripted schedules, not an actual outer LLM.',
  'The fixture HTML is not rendered; structured page state and failures are simulated.',
];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = code => Object.assign(new Error(code), { code });
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Validate and project the record schema; unknown properties never enter output. */
export function validateRecord(record) {
  if (!plain(record) || record.schemaVersion !== 1
    || !['offline-mock', 'live-external'].includes(record.evidenceMode)
    || !MODES.includes(record.mode) || !OUTCOMES.includes(record.outcome)
    || typeof record.taskId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(record.taskId)
    || !Number.isSafeInteger(record.iteration) || record.iteration < 1
    || !finite(record.latencyMs) || FLAGS.some(key => typeof record[key] !== 'boolean')
    || COUNTERS.some(key => !count(record[key]))
    || !(record.inputTokens === null || count(record.inputTokens))
    || !(record.expectedOutcomeMatched === null || typeof record.expectedOutcomeMatched === 'boolean')
    || !(record.blockedReason === null || (typeof record.blockedReason === 'string'
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(record.blockedReason)))) throw failure('INVALID_BENCHMARK_RECORD');
  if (record.blocked !== (record.outcome === 'blocked')
    || record.unverified !== (record.outcome === 'completion_candidate')
    || (record.verified && (record.outcome !== 'completed' || !record.taskSuccess))
    || (record.outcome === 'completed' && !record.verified)
    || (record.blocked && record.verified)) throw failure('INCONSISTENT_BENCHMARK_OUTCOME');
  const measurement = record.measurement;
  if (!plain(measurement)) throw failure('MISSING_MEASUREMENT_PROVENANCE');
  const offline = record.evidenceMode === 'offline-mock';
  if (measurement.latency !== (offline ? 'local-harness-clock' : 'external-wall-clock')
    || measurement.model !== (offline ? 'mock-client-calls' : 'external-model-logs')
    || measurement.browser !== (offline ? 'simulated-adapter' : 'external-protocol-logs')
    || measurement.tokens !== (record.inputTokens === null ? 'unavailable' : 'provider-reported')
    || typeof measurement.modelLatencyRepresentative !== 'boolean'
    || (offline && (record.inputTokens !== null || measurement.modelLatencyRepresentative !== false))) {
    throw failure('INVALID_MEASUREMENT_PROVENANCE');
  }
  return {
    schemaVersion: 1, evidenceMode: record.evidenceMode, mode: record.mode,
    taskId: record.taskId, iteration: record.iteration, outcome: record.outcome,
    ...Object.fromEntries(FLAGS.map(key => [key, record[key]])),
    expectedOutcomeMatched: record.expectedOutcomeMatched, blockedReason: record.blockedReason,
    latencyMs: record.latencyMs, ...Object.fromEntries(COUNTERS.map(key => [key, record[key]])),
    inputTokens: record.inputTokens,
    measurement: Object.fromEntries(['latency', 'model', 'browser', 'tokens', 'modelLatencyRepresentative']
      .map(key => [key, measurement[key]])),
  };
}

export function summarizeRecords(records) {
  if (!Array.isArray(records) || !records.length) throw failure('EMPTY_BENCHMARK_RECORDS');
  const rows = records.map(validateRecord);
  if (new Set(rows.map(row => `${row.evidenceMode}/${row.mode}`)).size !== 1) throw failure('MIXED_MEASUREMENT_GROUP');
  const latencies = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  const knownTokens = rows.filter(row => row.inputTokens !== null);
  const expectedRows = rows.filter(row => row.expectedOutcomeMatched !== null);
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const middle = Math.floor(rows.length / 2);
  return {
    runs: rows.length, taskCount: new Set(rows.map(row => row.taskId)).size,
    rates: {
      ...Object.fromEntries(FLAGS.map(key => [key, rows.filter(row => row[key]).length / rows.length])),
      expectedOutcomeMatched: expectedRows.length
        ? expectedRows.filter(row => row.expectedOutcomeMatched).length / expectedRows.length : null,
    },
    latencyMs: {
      median: rows.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2,
      p95: latencies[Math.ceil(rows.length * 0.95) - 1], min: latencies[0], max: latencies.at(-1),
    },
    modelCalls: { total: sum('modelCalls'), mean: sum('modelCalls') / rows.length },
    inputTokens: {
      total: knownTokens.length === rows.length ? sum('inputTokens') : null,
      knownTotal: knownTokens.reduce((total, row) => total + row.inputTokens, 0),
      recordsWithUsage: knownTokens.length, coverage: knownTokens.length / rows.length,
    },
    ...Object.fromEntries(COUNTERS.filter(key => key !== 'modelCalls').map(key => [key, sum(key)])),
  };
}

export function aggregateRecords(records) {
  if (!Array.isArray(records) || !records.length || records.length > 100000) throw failure('INVALID_RECORD_SET');
  const rows = records.map(validateRecord);
  const seen = new Set();
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.evidenceMode}/${row.mode}`;
    const identity = `${key}/${row.taskId}/${row.iteration}`;
    if (seen.has(identity)) throw failure('DUPLICATE_BENCHMARK_RECORD');
    seen.add(identity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, group]) => ({
    evidenceMode: key.split('/')[0], mode: key.split('/')[1],
    ...summarizeRecords(group),
    tasks: [...new Set(group.map(row => row.taskId))].map(taskId => ({
      taskId, ...summarizeRecords(group.filter(row => row.taskId === taskId)),
    })),
  }));
}

export async function loadFixtureTasks() {
  const html = await readFile(FIXTURE, 'utf8');
  const match = html.match(/<script id="fast-benchmark-spec" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw failure('FIXTURE_SPEC_MISSING');
  const tasks = JSON.parse(match[1]);
  if (!Array.isArray(tasks) || tasks.length !== 9) throw failure('INVALID_FIXTURE_SPEC');
  return tasks;
}

function createSimulation(task) {
  let revision = 1, url = START_URL, done = task.kind === 'unverified', staleRejected = false, stalePending = false;
  let field = '', selected = 'All';
  const stats = Object.fromEntries(COUNTERS.map(key => [key, 0]));
  const countDecision = () => {
    stats.modelCalls++;
    if (stalePending) { stats.retries++; stalePending = false; }
  };
  const resultText = task.kind === 'type' ? 'Search filled'
    : task.kind === 'select' ? 'Archived selected' : 'Details ready';
  const assertions = task.kind === 'unverified' ? [] : [{ textContains: resultText }];
  const context = () => ({ tabId: 1, runId: 'mock-outer', allowedDomains: ['fixture.example.test'],
    deadline: Date.now() + 10000, signal: new AbortController().signal });
  const element = () => ({
    ref: 'e1', role: task.kind === 'type' ? 'textbox' : task.kind === 'select' ? 'combobox' : 'button',
    name: task.kind === 'type' ? 'Search' : task.kind === 'select' ? 'Filter'
      : task.kind === 'sensitive' ? 'Send message' : 'Show details',
    visible: true, disabled: false, readOnly: false,
    tagName: task.kind === 'type' ? 'input' : task.kind === 'select' ? 'select' : 'button',
    inputType: task.kind === 'type' ? 'search' : '', sensitive: false,
    risk: task.kind === 'sensitive' ? 'sensitive' : null,
    value: task.kind === 'type' ? field : selected,
    operations: [task.kind === 'type' ? 'TYPE_TEXT' : task.kind === 'select' ? 'SELECT' : 'CLICK'],
    ...(task.kind === 'select' ? { options: [
      { id: 'e1:o0', index: 0, value: 'All', label: 'All', disabled: false, selected: selected === 'All' },
      { id: 'e1:o1', index: 1, value: 'Archived', label: 'Archived', disabled: false, selected: selected === 'Archived' },
    ] } : {}),
  });
  const adapter = {
    async open(nextUrl) { stats.protocolCalls++; url = nextUrl; return { tabId: 1 }; },
    async status() {
      stats.protocolCalls++;
      return new URL(url).hostname === 'fixture.example.test' ? {} : { blockedReason: 'DOMAIN_BLOCKED' };
    },
    async observe() {
      stats.protocolCalls++;
      return { snapshotId: `s${revision}`, url, title: 'Offline fixture',
        visibleText: done ? task.kind === 'unverified' ? 'Read-only page ready' : resultText : 'Ready',
        elements: task.kind === 'unverified' ? [] : [element()], scroll: { up: false, down: false }, challenge: false };
    },
    async execute(action) {
      stats.protocolCalls++;
      if (action.snapshotId !== `s${revision}`) throw failure('STALE_SNAPSHOT');
      if (task.kind === 'stale' && !staleRejected) {
        staleRejected = true; stalePending = true; revision++; stats.staleDecisions++;
        throw failure('STALE_SNAPSHOT');
      }
      if (task.kind === 'sensitive') throw failure('RISK_BLOCKED');
      const expectedOperation = task.kind === 'type' ? 'TYPE_TEXT' : task.kind === 'select' ? 'SELECT' : 'CLICK';
      if (action.operation !== expectedOperation || action.ref !== 'e1') throw failure('INVALID_MOCK_ACTION');
      if (task.kind === 'type' && action.text !== task.input) throw failure('INVALID_MOCK_INPUT');
      if (task.kind === 'select' && action.optionId !== 'e1:o1') throw failure('INVALID_MOCK_OPTION');
      stats.browserActions++;
      if (task.kind === 'no-effect') return { pageChanged: false };
      revision++;
      if (task.kind === 'domain') { url = 'https://outside.example.test/redirect'; return { pageChanged: true }; }
      if (task.kind === 'type') field = action.text;
      if (task.kind === 'select') selected = 'Archived';
      done = true;
      return { pageChanged: true };
    },
    async verify(checks) {
      stats.protocolCalls++;
      const passed = done && new URL(url).hostname === 'fixture.example.test';
      const results = checks.map((check, index) => ({ index,
        passed: passed && check.textContains === resultText }));
      return { verified: results.length > 0 && results.every(check => check.passed), checks: results };
    },
    async close() { /* Simulated per-run transport cleanup; it is not a bridge RPC. */ },
  };
  const client = {
    async decide({ questions }) {
      countDecision();
      let operation = done ? 'DONE' : task.kind === 'type' ? 'TYPE_TEXT' : task.kind === 'select' ? 'SELECT' : 'CLICK';
      if (!Object.hasOwn(questions.operation.criteria, operation)) operation = 'BLOCKED';
      const answers = {};
      for (const [head, question] of Object.entries(questions)) {
        const ids = Object.keys(question.criteria);
        let choice = head === 'operation' ? operation : ids[0];
        if (head === 'select_target') {
          choice = ids.find(id => JSON.stringify(question.criteria[id]).includes('Archived')) ?? ids.at(-1);
        }
        answers[head] = { type: 'choice', choice,
          probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])),
          confidence: task.kind === 'low-confidence' && head === 'operation' ? 0.1 : 1 };
      }
      return { id: `offline-mock-${stats.modelCalls}`, answers, usage: null };
    },
  };
  return { adapter, client, stats, assertions, context, countDecision,
    goalReached: () => done, resultText, task,
    nextAction: snapshot => ({ operation: task.kind === 'type' ? 'TYPE_TEXT' : task.kind === 'select' ? 'SELECT' : 'CLICK',
      snapshotId: snapshot.snapshotId, expectedUrl: snapshot.url, ref: 'e1',
      ...(task.kind === 'type' ? { text: task.input } : {}),
      ...(task.kind === 'select' ? { optionId: 'e1:o1' } : {}) }),
  };
}

/** Declared schedule: snapshot -> outer decision -> action; final decision -> verify. */
async function runOuter(simulation, { continueFromPage = false } = {}) {
  const { adapter, task, assertions } = simulation;
  const context = simulation.context();
  if (!continueFromPage) await adapter.open(START_URL, context);
  let snapshot = await adapter.observe(context);
  for (let step = 0; step < 8; step++) {
    simulation.countDecision();
    const scope = await adapter.status(context);
    if (scope.blockedReason) return { status: 'blocked', verified: false, blockedReason: scope.blockedReason };
    if (simulation.goalReached()) {
      if (!assertions.length) return { status: 'completion_candidate', verified: false, blockedReason: null };
      const verification = await adapter.verify(assertions, context);
      return { status: verification.verified ? 'completed' : 'blocked', verified: verification.verified,
        blockedReason: verification.verified ? null : 'UNMET_ASSERTIONS' };
    }
    if (task.kind === 'sensitive') return { status: 'blocked', verified: false, blockedReason: 'RISK_BLOCKED' };
    let receipt;
    try { receipt = await adapter.execute(simulation.nextAction(snapshot), context); }
    catch (error) {
      if (error.code !== 'STALE_SNAPSHOT') throw error;
      snapshot = await adapter.observe(context);
      continue;
    }
    if (!receipt.pageChanged) return { status: 'blocked', verified: false, blockedReason: 'NO_EFFECT' };
    const nextScope = await adapter.status(context);
    if (nextScope.blockedReason) return { status: 'blocked', verified: false, blockedReason: nextScope.blockedReason };
    snapshot = await adapter.observe(context);
  }
  return { status: 'blocked', verified: false, blockedReason: 'STEP_BUDGET' };
}

async function runOne(task, mode, iteration, directory) {
  const simulation = createSimulation(task);
  const started = performance.now();
  let result, escalated = false;
  if (mode === 'A') {
    result = await runOuter(simulation);
    if (result.status === 'blocked') simulation.stats.safetyEscalations++;
  }
  else {
    result = await runTask({ enabled: true, url: START_URL, goal: task.goal,
      allowedDomains: [], assertions: simulation.assertions,
      inputs: task.kind === 'type' ? [{ name: 'Search', role: 'textbox', text: task.input }] : [],
      maxSteps: 8, maxModelCalls: 8, maxNoEffect: 1, timeoutMs: 10000,
      tracePath: path.join(directory, `${mode}-${task.id}-${iteration}.jsonl`),
    }, { adapter: simulation.adapter, client: simulation.client, env: {} });
    if (result.status === 'blocked') simulation.stats.safetyEscalations++;
    if (mode === 'C' && result.status === 'blocked') {
      escalated = true;
      simulation.stats.modelCalls++; // Scripted outer assessment of the fast result.
      if (task.kind === 'low-confidence' && result.blockedReason === 'LOW_CONFIDENCE') {
        result = await runOuter(simulation, { continueFromPage: true });
      }
    }
  }
  const latencyMs = performance.now() - started;
  return validateRecord({ schemaVersion: 1, evidenceMode: 'offline-mock', mode, taskId: task.id,
    iteration, outcome: result.status, taskSuccess: simulation.goalReached(), verified: result.verified,
    blocked: result.status === 'blocked', unverified: result.status === 'completion_candidate', escalated,
    expectedOutcomeMatched: result.status === task.expected[mode], blockedReason: result.blockedReason ?? null,
    latencyMs, ...simulation.stats, inputTokens: null,
    measurement: { latency: 'local-harness-clock', model: 'mock-client-calls', tokens: 'unavailable',
      browser: 'simulated-adapter', modelLatencyRepresentative: false },
  });
}

export async function runBenchmark({ iterations = 3, taskId } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw failure('INVALID_ITERATIONS');
  const available = await loadFixtureTasks();
  const tasks = taskId ? available.filter(task => task.id === taskId) : available;
  if (!tasks.length) throw failure('UNKNOWN_TASK');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'beat-browser-offline-'));
  const records = [];
  try {
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (const task of tasks) {
        for (const mode of MODES) records.push(await runOne(task, mode, iteration, directory));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  return { schemaVersion: 1, evidenceMode: 'offline-mock', limitations: LIMITATIONS,
    fixture: 'test/fixtures/fast-agent.html', records, summaries: aggregateRecords(records) };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') {
      process.stdout.write('Usage: node scripts/benchmark-fast-agent.mjs [--iterations 1..100] [--task ID]\n'
        + '       node scripts/benchmark-fast-agent.mjs --input-records FILE\n');
      return;
    }
    if (!['--iterations', '--task', '--input-records'].includes(flag) || options[flag] !== undefined
      || !args[index + 1] || args[index + 1].startsWith('--')) throw failure('INVALID_ARGUMENTS');
    options[flag] = args[++index];
  }
  let result;
  if (options['--input-records']) {
    if (options['--iterations'] || options['--task']) throw failure('CONFLICTING_ARGUMENTS');
    const content = await readFile(options['--input-records'], 'utf8');
    if (content.length > 16000000) throw failure('RECORD_FILE_TOO_LARGE');
    const data = JSON.parse(content);
    if (!plain(data) || data.schemaVersion !== 1 || !Array.isArray(data.records)
      || data.records.some(record => record.evidenceMode !== 'live-external')) throw failure('INVALID_EXTERNAL_RECORDS');
    result = { schemaVersion: 1, evidenceMode: 'live-external',
      limitations: ['Imported provenance is supplied by the collector and is not independently verified.'],
      records: data.records.map(validateRecord), summaries: aggregateRecords(data.records) };
  } else result = await runBenchmark({
    iterations: options['--iterations'] === undefined ? 3 : Number(options['--iterations']), taskId: options['--task'],
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code : 'BENCHMARK_FAILED';
    process.stderr.write(`Benchmark error: ${code}\n`);
    process.exitCode = 1;
  });
}
