import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask, validateTaskOptions } from '../src/fast-agent/runner.js';
import { createBeatAPIClient } from '../src/fast-agent/client.js';
import { redactFastParams } from '../src/bridge.js';

const clickable = (name = 'Details') => ({ ref: 'e1', role: 'button', name, tagName: 'BUTTON',
  inputType: 'button', visible: true, disabled: false, readOnly: false, sensitive: false,
  risk: null, operations: ['CLICK'] });
const textbox = () => ({ ...clickable('Search'), tagName: 'INPUT', inputType: 'search',
  role: 'searchbox', operations: ['TYPE_TEXT'], value: '' });

function answer(questions, operation = 'DONE', targetId, confidence = 0.95) {
  const answers = {};
  for (const [head, question] of Object.entries(questions)) {
    const ids = Object.keys(question.criteria);
    const choice = head === 'operation' ? operation : targetId && ids.includes(targetId) ? targetId : ids[0];
    answers[head] = { type: 'choice', choice, confidence,
      probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])) };
  }
  return { id: 'offline_request', answers, usage: { input_tokens: 10, output_tokens: 1 } };
}

function harness(t, { elements = [clickable()], operations = ['CLICK', 'DONE'], execute, verify,
  respond, observe, status, generateText } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-fast-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sequence = 0, decisions = 0;
  const state = { text: 'A public fixture', url: 'https://example.com/', actions: [], calls: [],
    after: false, currentElements: elements, aborted: false, payloads: [] };
  const adapter = {
    async open(url, context) { state.calls.push('open'); return { tabId: 7, url }; },
    async status(context) { state.calls.push('status'); return status ? status(state, context) : {}; },
    async observe(context) {
      state.calls.push('observe');
      if (observe) await observe(state, context);
      return { snapshotId: `s${++sequence}`, url: state.url, title: 'Public fixture',
        visibleText: state.text, elements: structuredClone(state.currentElements),
        scroll: { up: false, down: true }, challenge: false };
    },
    async execute(action, context) {
      state.calls.push('execute');
      if (execute) return execute(action, state, context);
      state.actions.push(action); state.after = true; state.text = 'Details visible';
      return { pageChanged: true, navigated: false };
    },
    async verify(assertions, context) {
      state.calls.push('verify');
      if (verify) return verify(assertions, state, context);
      const passed = state.after;
      return { verified: passed, checks: assertions.map((_, index) => ({ index, passed })) };
    },
    async ask(reason) { state.calls.push('ask'); return { outcome: 'continued' }; },
    async abort() { state.calls.push('abort'); state.aborted = true; },
    close() { state.calls.push('close'); },
  };
  const client = {
    async decide(request) {
      state.payloads.push(request);
      const index = decisions++;
      if (respond) return respond(request, index, state);
      return answer(request.questions, operations[index] || operations.at(-1));
    },
    async generateText(request) {
      if (generateText) return generateText(request, state);
      throw Object.assign(new Error('No configured helper'), { code: 'MISSING_TEXT_MODEL' });
    },
  };
  const options = { enabled: true, url: 'https://example.com/', goal: 'Open the details.',
    timeoutMs: 10000, tracePath: path.join(dir, 'trace.jsonl') };
  return { state, adapter, client, options,
    run(extra = {}, deps = {}) { return runTask({ ...options, ...extra }, { adapter, client, ...deps }); } };
}

test('disabled mode and offline dry run make no model or bridge calls', async (t) => {
  const h = harness(t);
  assert.equal((await h.run({ enabled: false })).status, 'disabled');
  const dry = await h.run({ dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.deepEqual(dry.allowedDomains, ['example.com']);
  assert.deepEqual(h.state.calls, []);
  assert.deepEqual(h.state.payloads, []);
  assert.equal(fs.existsSync(h.options.tracePath), false);
});

test('missing API key fails before browser setup or trace creation', async (t) => {
  const h = harness(t);
  const result = await runTask(h.options, { adapter: h.adapter, env: {} });
  assert.equal(result.blockedReason, 'MISSING_API_KEY');
  assert.equal(result.metrics.modelCalls, 0);
  assert.deepEqual(h.state.calls, []);
  assert.equal(fs.existsSync(h.options.tracePath), false);
});

test('invalid task and assertions fail locally; empty field assertion is valid', () => {
  for (const value of [{ maxSteps: 0 }, { maxModelCalls: Infinity }, { allowedDomains: ['*.example.com'] },
    { assertions: [{}] }, { assertions: [{ selector: 'input', value: 'x', not: true }] },
    { inputs: [{ name: 'Search', ref: 'e1', text: 'query' }] }]) {
    assert.throws(() => validateTaskOptions({ enabled: true, url: 'https://example.com/', goal: 'Read', ...value }));
  }
  assert.equal(validateTaskOptions({ url: 'https://example.com/', goal: 'Read',
    assertions: [{ selector: '#field', value: '' }] }).assertions[0].value, '');
});

test('verified completion requires current deterministic assertions', async (t) => {
  const h = harness(t);
  const result = await h.run({ assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.verified, true);
  assert.equal(result.metrics.actions, 1);
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(h.state.actions[0].snapshotId, 's1');
  assert.deepEqual(Object.keys(h.state.actions[0]).sort(), ['expectedUrl', 'operation', 'ref', 'snapshotId']);
  assert.equal(fs.statSync(h.options.tracePath).mode & 0o777, 0o600);
});

test('DONE without assertions is only an unverified completion candidate', async (t) => {
  const h = harness(t, { operations: ['DONE'] });
  const result = await h.run();
  assert.equal(result.status, 'completion_candidate');
  assert.equal(result.verified, false);
  assert.equal(h.state.actions.length, 0);
});

test('DONE cannot override a false assertion or inconsistent verifier', async (t) => {
  const h = harness(t, { operations: ['DONE'] });
  assert.equal((await h.run({ assertions: [{ selectorExists: '#missing' }] })).blockedReason, 'UNMET_ASSERTIONS');
  const bad = harness(t, { verify: () => ({ verified: true, checks: [{ index: 0, passed: false }] }) });
  assert.equal((await bad.run({ assertions: [{ textContains: 'Expected' }] })).blockedReason, 'INVALID_VERIFICATION');
  assert.equal(bad.state.actions.length, 0);
});

test('malformed and low-confidence decisions execute zero actions', async (t) => {
  const cases = [() => ({}), (request) => answer(request.questions, 'EVAL'),
    (request) => answer(request.questions, 'CLICK', undefined, 0.1),
    (request) => { const raw = answer(request.questions, 'CLICK'); raw.answers.click_target.probabilities = { e1: NaN }; return raw; }];
  for (const respond of cases) {
    const h = harness(t, { respond });
    const result = await h.run();
    assert.ok(['INVALID_DECISION', 'LOW_CONFIDENCE'].includes(result.blockedReason));
    assert.equal(h.state.actions.length, 0);
  }
});

test('default confidence floor accepts a guarded low-confidence browser choice', async (t) => {
  const h = harness(t, { respond: (request) => answer(request.questions, 'CLICK', undefined, 0.3) });
  const result = await h.run({ assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(h.state.actions.length, 1);
});

test('an exact caller input removes discretionary model blocking while safe progress exists', async (t) => {
  const h = harness(t, { elements: [textbox()], respond: (request) => {
    assert.equal('BLOCKED' in request.questions.operation.criteria, false);
    return answer(request.questions, 'TYPE_TEXT', 'e1');
  } });
  const result = await h.run({ inputs: [{ name: 'Search', role: 'searchbox', text: 'exact query' }],
    assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed');
  assert.equal(h.state.actions[0].text, 'exact query');
});

test('caller-provided exact click names narrow the model target set', async (t) => {
  const elements = [clickable('52 replies. Reply'), { ...clickable('Reply'), ref: 'e2' }];
  const h = harness(t, { elements, respond: (request, index) => {
    if (index === 0) assert.deepEqual(Object.keys(request.questions.click_target.criteria), ['e2']);
    return index === 0 ? answer(request.questions, 'CLICK', 'e2') : answer(request.questions, 'DONE');
  } });
  const result = await h.run({ clickNames: ['Reply'] });
  assert.equal(result.status, 'completion_candidate', JSON.stringify(result));
  assert.equal(h.state.actions[0].ref, 'e2');
});

test('caller-provided exact inputs hide unrelated text fields from JEV', async (t) => {
  const elements = [
    { ...textbox(), ref: 'e1', name: 'Unrelated query' },
    { ...textbox(), ref: 'e2', name: 'Search' },
  ];
  const h = harness(t, { elements, respond: (request) => {
    assert.deepEqual(Object.keys(request.questions.type_text_target.criteria), ['e2']);
    return answer(request.questions, 'TYPE_TEXT', 'e2');
  } });
  const result = await h.run({ inputs: [{ name: 'Search', role: 'searchbox', text: 'exact query' }],
    assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed');
  assert.equal(h.state.actions[0].ref, 'e2');
});

test('missing exact targets remove WAIT and DONE while scrolling can still find them', async (t) => {
  const h = harness(t, { elements: [clickable('Unrelated')], respond: (request) => {
    assert.deepEqual(Object.keys(request.questions.operation.criteria), ['SCROLL_DOWN']);
    return answer(request.questions, 'SCROLL_DOWN');
  } });
  const result = await h.run({ clickNames: ['Reply'], maxSteps: 1 });
  assert.equal(result.blockedReason, 'STEP_BUDGET');
  assert.equal(h.state.actions[0].operation, 'SCROLL_DOWN');
});

test('typing waits briefly for reactive controls before the next observation', async (t) => {
  const h = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT', 'CLICK'],
    execute: (action, state) => {
      state.actions.push(action);
      if (action.operation === 'TYPE_TEXT') setTimeout(() => { state.currentElements = [clickable('Reply')]; }, 20);
      else { state.after = true; state.text = 'Details visible'; }
      return { pageChanged: true };
    } });
  const result = await h.run({ inputs: [{ name: 'Search', role: 'searchbox', text: 'exact query' }],
    assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.state.actions.map((action) => action.operation), ['TYPE_TEXT', 'CLICK']);
});

test('a submit click waits briefly for reactive success evidence', async (t) => {
  const h = harness(t, { execute: (action, state) => {
    state.actions.push(action);
    setTimeout(() => { state.after = true; state.text = 'Details visible'; }, 20);
    return { pageChanged: true };
  } });
  const result = await h.run({ clickNames: ['Details'], assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(h.state.actions.length, 1);
});

test('a pre-dispatch stale decision is discarded and decided again', async (t) => {
  let stale = true;
  const h = harness(t, { operations: ['CLICK', 'CLICK', 'DONE'], execute: (action, state) => {
    if (stale) { stale = false; return { blockedReason: 'STALE_SNAPSHOT', pageChanged: false }; }
    state.actions.push(action); state.after = true; state.text = 'Details visible';
    return { pageChanged: true };
  } });
  const result = await h.run({ assertions: [{ textContains: 'Details visible' }] });
  assert.equal(result.verified, true);
  assert.equal(result.metrics.staleDecisions, 1);
  assert.equal(result.metrics.modelCalls, 2);
  assert.equal(h.state.actions.length, 1);
  assert.equal(h.state.actions[0].snapshotId, 's2');
});

test('stale retries are bounded and consume model/step budget', async (t) => {
  const h = harness(t, { operations: ['CLICK'], execute: () => ({ pageChanged: false, blockedReason: 'STALE_SNAPSHOT' }) });
  const result = await h.run({ maxStaleRetries: 1 });
  assert.equal(result.blockedReason, 'STALE_LIMIT');
  assert.equal(result.metrics.modelCalls, 2);
  assert.equal(result.metrics.actions, 0);
});

test('known page changes invalidate DONE and helper targets before completion or drafting', async (t) => {
  for (const operation of ['DONE', 'TYPE_TEXT']) {
    let stale = false, once = true, helperCalls = 0;
    const h = harness(t, { elements: [textbox()],
      respond: (request) => { if (once) { stale = true; once = false; } return answer(request.questions, operation); },
      status: () => { const out = { stale }; stale = false; return out; },
      generateText: () => { helperCalls++; return 'safe words'; } });
    const result = await h.run({ allowTextHelper: true, maxModelCalls: 2 });
    assert.equal(result.metrics.staleDecisions, 1);
    assert.equal(result.metrics.jevCalls, 2);
    assert.equal(helperCalls, 0);
    assert.equal(h.state.actions.length, 0);
    assert.equal(result.status, operation === 'DONE' ? 'completion_candidate' : 'blocked');
  }
});

test('a repeated click is blocked even if the first receipt claimed a change', async (t) => {
  const h = harness(t, { operations: ['CLICK'] });
  const result = await h.run();
  assert.equal(result.blockedReason, 'REPEATED_ACTION');
  assert.equal(h.state.actions.length, 1);
});

test('no-effect WAIT loop stops and does not dispatch browser actions', async (t) => {
  const h = harness(t, { operations: ['WAIT'] });
  const result = await h.run({ waitMs: 0, maxNoEffect: 2 });
  assert.equal(result.blockedReason, 'NO_EFFECT');
  assert.equal(result.metrics.steps, 2);
  assert.equal(h.state.actions.length, 0);
});

test('step and model budgets stop before extra inference or actions', async (t) => {
  const h = harness(t, { operations: ['WAIT'] });
  const a = await h.run({ maxSteps: 1, waitMs: 0 });
  assert.equal(a.blockedReason, 'STEP_BUDGET');
  assert.equal(a.metrics.modelCalls, 1);
  const g = harness(t, { operations: ['WAIT'] });
  const b = await g.run({ maxModelCalls: 1, maxNoEffect: 5, waitMs: 0 });
  assert.equal(b.blockedReason, 'MODEL_BUDGET');
  assert.equal(b.metrics.modelCalls, 1);
});

test('exact deterministic input is typed locally and never included in JEV state', async (t) => {
  const h = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT', 'DONE'] });
  const result = await h.run({ inputs: [{ name: 'Search', text: 'mountain trails' }] });
  assert.equal(result.status, 'completion_candidate');
  assert.equal(h.state.actions[0].text, 'mountain trails');
  assert.equal(JSON.stringify(h.state.payloads).includes('mountain trails'), false);
  const trace = fs.readFileSync(h.options.tracePath, 'utf8');
  assert.equal(trace.includes('mountain trails'), false);
});

test('TYPE_TEXT does not guess values or silently choose a text model', async (t) => {
  const a = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT'] });
  assert.equal((await a.run()).blockedReason, 'TEXT_REQUIRED');
  assert.equal(a.state.actions.length, 0);
  const b = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT'] });
  assert.equal((await b.run({ allowTextHelper: true })).blockedReason, 'MISSING_TEXT_MODEL');
  assert.equal(b.state.actions.length, 0);
  assert.equal(b.state.payloads.length, 1);
});

test('text-helper calls share budget and malformed helper text cannot be typed', async (t) => {
  const a = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT'], generateText: () => 'trail map' });
  assert.equal((await a.run({ allowTextHelper: true, maxModelCalls: 1 })).blockedReason, 'MODEL_BUDGET');
  assert.equal(a.state.actions.length, 0);
  const b = harness(t, { elements: [textbox()], operations: ['TYPE_TEXT'], generateText: () => 'Contact alex\u200b@example.com' });
  const result = await b.run({ allowTextHelper: true });
  assert.equal(result.blockedReason, 'INVALID_TEXT');
  assert.equal(result.metrics.modelCalls, 2);
  assert.equal(result.metrics.inputTokens, null);
  assert.equal(b.state.actions.length, 0);
});

test('ambiguous field-name input stops before typing', async (t) => {
  const h = harness(t, { elements: [textbox(), { ...textbox(), ref: 'e2' }], operations: ['TYPE_TEXT'] });
  assert.equal((await h.run({ inputs: [{ name: 'Search', text: 'parks' }] })).blockedReason, 'AMBIGUOUS_INPUT');
  assert.equal(h.state.actions.length, 0);
});

test('native SELECT executes only the code-owned option ID', async (t) => {
  const h = harness(t, { elements: [{ ...textbox(), tagName: 'SELECT', inputType: '', role: 'combobox',
    name: 'Sort', operations: ['SELECT'], options: [{ id: 'e1:o0', index: 0, label: 'Lowest price', disabled: false, selected: false }] }],
    operations: ['SELECT', 'DONE'] });
  const result = await h.run();
  assert.equal(result.status, 'completion_candidate');
  assert.equal(h.state.actions[0].optionId, 'e1:o0');
  assert.equal('value' in h.state.actions[0], false);
});

test('domain drift after a click stops before another page is sent to JEV', async (t) => {
  const h = harness(t, { execute: (action, state) => {
    state.actions.push(action); state.url = 'https://elsewhere.example/'; return { pageChanged: true };
  } });
  const result = await h.run();
  assert.equal(result.blockedReason, 'DOMAIN_BLOCKED');
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(h.state.actions.length, 1);
});

test('runner exposes caller-scoped business actions without a built-in policy veto', async (t) => {
  const h = harness(t, { elements: [clickable('Pay now')], operations: ['CLICK', 'DONE'], respond: (request, index) => {
    assert.equal('CLICK' in request.questions.operation.criteria, true);
    return answer(request.questions, index === 0 ? 'CLICK' : 'DONE');
  } });
  const result = await h.run();
  assert.equal(result.status, 'completion_candidate');
  assert.equal(h.state.actions.length, 1);
  assert.equal(h.state.actions[0].operation, 'CLICK');
});

test('unknown execution error or failed post-action observe never replays the action', async (t) => {
  const h = harness(t, { execute: (action, state) => {
    state.actions.push(action); throw new Error('provider/private error body');
  } });
  const result = await h.run();
  assert.equal(result.status, 'error');
  assert.equal(h.state.actions.length, 1);
  assert.equal(result.metrics.retries, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const g = harness(t, { observe: (state) => { if (state.after) throw new Error('Observe failed'); } });
  assert.equal((await g.run()).status, 'error');
  assert.equal(g.state.actions.length, 1);
  assert.match(fs.readFileSync(g.options.tracePath, 'utf8'), /executed/);
});

test('abort and deadline interrupt inference with zero mutations', async (t) => {
  const c = new AbortController();
  const h = harness(t, { respond: async () => { c.abort(); return new Promise(() => {}); } });
  const result = await h.run({ signal: c.signal });
  assert.equal(result.status, 'aborted');
  assert.equal(h.state.actions.length, 0);
  const g = harness(t, { respond: async () => new Promise(() => {}) });
  const timeout = await g.run({ timeoutMs: 25 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(g.state.actions.length, 0);
});

test('trace rejects overwrite and bridge audit contains no task data', async (t) => {
  const h = harness(t);
  fs.writeFileSync(h.options.tracePath, 'previous trace');
  assert.equal((await h.run()).blockedReason, 'TRACE_WRITE_FAILED');
  assert.equal(fs.readFileSync(h.options.tracePath, 'utf8'), 'previous trace');
  assert.deepEqual(h.state.calls, []);
  const logged = redactFastParams({ operation: 'TYPE_TEXT', ref: 'e1', snapshotId: 's1',
    text: 'private', assertions: [{ textContains: 'private' }], url: 'https://example.com/?token=private',
    allowedDomains: ['private.example'], Authorization: 'private', password: 'private' });
  assert.deepEqual(logged, { operation: 'TYPE_TEXT', ref: 'e1', snapshotId: 's1' });
});

test('runner integrates native-fetch BeatAPI client with offline responses only', async (t) => {
  const h = harness(t, { elements: [textbox()] });
  const requests = [];
  const key = 'offline-fixture-key-only';
  const client = createBeatAPIClient({ env: { BEATAPI_API_KEY: key, BEAT_BROWSER_TEXT_MODEL: 'explicit-fixture-model' },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const payload = requests.at(-1).body;
      if (url.endsWith('/systemone')) {
        return new Response(JSON.stringify(answer(payload.questions, requests.length === 1 ? 'TYPE_TEXT' : 'DONE')), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'offline_text', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"text":"trail map"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    } });
  const result = await h.run({ allowTextHelper: true }, { client });
  assert.equal(result.status, 'completion_candidate');
  assert.equal(result.metrics.modelCalls, 3);
  assert.equal(h.state.actions[0].text, 'trail map');
  assert.equal(requests.filter((r) => r.url.endsWith('/systemone')).length, 2);
  assert.equal(requests.filter((r) => r.url.endsWith('/chat/completions')).length, 1);
  assert.equal(fs.readFileSync(h.options.tracePath, 'utf8').includes(key), false);
});
