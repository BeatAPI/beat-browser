import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeatAPIClient, validateTextValue } from '../src/fast-agent/client.js';
import { buildQuestions, validateDecision } from '../src/fast-agent/decision.js';

const KEY = 'offline-mock-credential-7d52';
const ENV = { BEATAPI_API_KEY: KEY };
const TEXT_ENV = { ...ENV, BEAT_BROWSER_TEXT_MODEL: 'explicit-text-model' };
const INPUT = { role: 'textbox', name: 'Search', tagName: 'input', inputType: 'search' };

function actionSpace() {
  return {
    operations: ['CLICK', 'TYPE_TEXT', 'SELECT', 'WAIT', 'DONE', 'BLOCKED'],
    targets: {
      CLICK: { e1: { ref: 'e1', role: 'button', name: 'Details' }, e2: { ref: 'e2', role: 'link', name: 'Documentation' } },
      TYPE_TEXT: { e3: { ref: 'e3', ...INPUT } },
      SELECT: { 'e4:o0': { ref: 'e4', optionId: 'o0', role: 'combobox', name: 'Size', label: 'Small' } },
    },
    excluded: [],
  };
}

function responseFor(questions, operation = 'CLICK') {
  const answers = {};
  for (const [head, question] of Object.entries(questions)) {
    const ids = Object.keys(question.criteria);
    const choice = head === 'operation' ? operation : ids[0];
    answers[head] = {
      type: 'choice', choice, confidence: 0.95,
      probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
    };
  }
  return { id: 'request-offline-1', answers, usage: { input_tokens: 120, output_tokens: 10, total_tokens: 130 } };
}

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...options });
}

function textResponse(content = '{"text":"blue shoes"}', changes = {}) {
  return { id: 'text-offline-1', usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], ...changes };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(KEY));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('question builder emits closed JEV heads and sanitized metadata, with no field values', () => {
  const space = actionSpace();
  space.targets.CLICK.e1.name = 'Details person@example.test token=abcd1234';
  space.targets.CLICK.e1.value = 'raw-private-value';
  space.targets.CLICK.e1.selector = '#untrusted';
  space.targets.SELECT['e4:o0'].value = 'raw-option-value';
  const questions = buildQuestions(space);
  assert.deepEqual(Object.keys(questions), ['operation', 'click_target', 'type_text_target', 'select_target']);
  assert.equal(questions.operation.type, 'choice');
  assert.deepEqual(Object.keys(questions.click_target.criteria), ['e1', 'e2']);
  assert.equal(questions.select_target.criteria['e4:o0'].label, 'Small');
  const serialized = JSON.stringify(questions);
  for (const omitted of ['person@example.test', 'abcd1234', 'raw-private-value', '#untrusted', 'raw-option-value', 'optionId']) {
    assert.ok(!serialized.includes(omitted), omitted);
  }
  assert.match(questions.type_text_target.instructions, /Assume the chosen operation is TYPE_TEXT/);
});

test('question builder removes empty target operations and never invents targets', () => {
  const questions = buildQuestions({ operations: ['CLICK', 'WAIT', 'DONE'], targets: { CLICK: {} } });
  assert.deepEqual(Object.keys(questions), ['operation']);
  assert.deepEqual(Object.keys(questions.operation.criteria), ['WAIT', 'DONE']);
  assert.throws(() => buildQuestions({ operations: ['CLICK'], targets: {} }), expectCode('INVALID_ACTION_SPACE'));
  assert.throws(() => buildQuestions({ operations: ['EVAL'], targets: {} }), expectCode('INVALID_ACTION_SPACE'));
  assert.throws(() => buildQuestions({ operations: ['WAIT', 'WAIT'], targets: {} }), expectCode('INVALID_ACTION_SPACE'));
});

test('a validated decision selects only the compatible head and copies probabilities', () => {
  const questions = buildQuestions(actionSpace());
  const raw = responseFor(questions, 'TYPE_TEXT');
  raw.answers.type_text_target.confidence = 0.9;
  raw.answers.click_target.confidence = 0.1; // Valid speculative head; not selected.
  const decision = validateDecision(raw, questions);
  assert.equal(decision.operation, 'TYPE_TEXT');
  assert.equal(decision.targetId, 'e3');
  assert.equal(decision.confidence, 0.9);
  assert.equal(decision.operationConfidence, 0.95);
  assert.equal(decision.targetConfidence, 0.9);
  assert.deepEqual(decision.probabilities.target, { e3: 1 });
  decision.probabilities.operation.TYPE_TEXT = 0;
  assert.equal(raw.answers.operation.probabilities.TYPE_TEXT, 1);
});

test('every malformed speculative head invalidates the entire response before action', async (t) => {
  const mutations = {
    'missing selected head': (r) => { delete r.answers.click_target; },
    'missing unused head': (r) => { delete r.answers.type_text_target; },
    'extra answer head': (r) => { r.answers.navigate_target = r.answers.click_target; },
    'wrong head type': (r) => { r.answers.select_target.type = 'text'; },
    'unknown target': (r) => { r.answers.select_target.choice = 'e999:o0'; },
    'unknown operation': (r) => { r.answers.operation.choice = 'EVAL'; },
    'missing probability': (r) => { delete r.answers.click_target.probabilities.e2; },
    'extra probability': (r) => { r.answers.click_target.probabilities.e3 = 0; },
    'NaN probability': (r) => { r.answers.click_target.probabilities.e1 = NaN; },
    'infinite probability': (r) => { r.answers.click_target.probabilities.e1 = Infinity; },
    'negative probability': (r) => { r.answers.click_target.probabilities.e2 = -0.01; },
    'oversized probability': (r) => { r.answers.click_target.probabilities.e1 = 1.01; },
    'wrong sum': (r) => { r.answers.click_target.probabilities = { e1: 0.6, e2: 0.2 }; },
    'not maximum choice': (r) => { r.answers.click_target.probabilities = { e1: 0.4, e2: 0.6 }; },
    'string confidence': (r) => { r.answers.click_target.confidence = '1'; },
    'boolean probability': (r) => { r.answers.click_target.probabilities.e1 = true; },
    'confidence out of range': (r) => { r.answers.type_text_target.confidence = 2; },
    'numeric choice': (r) => { r.answers.click_target.choice = 1; },
    'array probabilities': (r) => { r.answers.click_target.probabilities = [1, 0]; },
    'extra execution channel': (r) => { r.answers.click_target.selector = '#pay-now'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const questions = buildQuestions(actionSpace());
      const raw = responseFor(questions);
      mutate(raw);
      assert.throws(() => validateDecision(raw, questions), expectCode('INVALID_DECISION'));
    });
  }
});

test('validation rejects inherited/accessor answers without executing their accessors', () => {
  const questions = buildQuestions(actionSpace());
  const inherited = responseFor(questions);
  inherited.answers.click_target = Object.create(inherited.answers.click_target);
  assert.throws(() => validateDecision(inherited, questions), expectCode('INVALID_DECISION'));
  const accessor = responseFor(questions);
  let reads = 0;
  Object.defineProperty(accessor.answers.click_target, 'choice', { enumerable: true, get() { reads++; return 'e1'; } });
  assert.throws(() => validateDecision(accessor, questions), expectCode('INVALID_DECISION'));
  assert.equal(reads, 0);
});

test('operation and selected target require minimum confidence; DONE has no target', () => {
  const questions = buildQuestions(actionSpace());
  for (const head of ['operation', 'click_target']) {
    const raw = responseFor(questions);
    raw.answers[head].confidence = 0.79;
    assert.throws(() => validateDecision(raw, questions), expectCode('LOW_CONFIDENCE'));
  }
  const done = validateDecision(responseFor(questions, 'DONE'), questions);
  assert.equal(done.operation, 'DONE');
  assert.equal(done.targetId, undefined);
  assert.deepEqual(done.probabilities.target, {});
  for (const value of [NaN, Infinity, -0.1, 1.1, '0.8', true]) {
    assert.throws(() => validateDecision(responseFor(questions), questions, { minConfidence: value }), expectCode('INVALID_CONFIDENCE'));
  }
});

test('invalid local questions cannot expand the fixed operation protocol', () => {
  const questions = buildQuestions(actionSpace());
  questions.operation.criteria.NAVIGATE = 'Go anywhere';
  assert.throws(() => validateDecision(responseFor(questions), questions), expectCode('INVALID_QUESTIONS'));
  const mismatch = buildQuestions(actionSpace());
  delete mismatch.select_target;
  assert.throws(() => validateDecision(responseFor(mismatch), mismatch), expectCode('INVALID_QUESTIONS'));
});

test('client construction is the first point requiring a key; no default text model', async () => {
  assert.throws(() => createBeatAPIClient({ env: {} }), expectCode('MISSING_API_KEY'));
  let calls = 0;
  const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => { calls++; throw new Error('must not run'); } });
  await assert.rejects(client.generateText({ goal: 'Find blue shoes', target: INPUT }), expectCode('MISSING_TEXT_MODEL'));
  assert.equal(calls, 0);
  assert.equal(client.lastMetadata, null);
});

test('JEV uses one systemone POST with typed questions and no chat-message envelope', async () => {
  const questions = buildQuestions(actionSpace());
  let calls = 0;
  const client = createBeatAPIClient({ env: ENV, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.beatapi.io/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-1.13');
    assert.deepEqual(body.state, { goal: 'Read documentation' });
    assert.deepEqual(body.questions, questions);
    assert.equal(body.messages, undefined);
    assert.equal(body.choices, undefined);
    assert.ok(!options.body.includes(KEY));
    return jsonResponse({ ...responseFor(questions), provider_debug: KEY });
  } });
  const result = await client.decide({ state: { goal: 'Read documentation' }, questions });
  assert.equal(calls, 1);
  assert.equal(result.id, 'request-offline-1');
  assert.equal(result.provider_debug, undefined);
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 10, total_tokens: 130 });
  assert.equal(validateDecision(result, questions).targetId, 'e1');
});

test('explicit model and versioned loopback base are configuration-only overrides', async () => {
  const questions = buildQuestions(actionSpace());
  const client = createBeatAPIClient({
    env: { ...ENV, BEATAPI_BASE_URL: 'http://127.0.0.1:9876/v1/', BEAT_BROWSER_JEV_MODEL: 'jev-explicit' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:9876/v1/systemone');
      assert.equal(JSON.parse(options.body).model, 'jev-explicit');
      return jsonResponse(responseFor(questions));
    },
  });
  await client.decide({ state: {}, questions, baseUrl: 'https://untrusted.invalid', model: 'untrusted' });
});

test('invalid URLs, API-key header injection and model identifiers fail before fetch', () => {
  for (const value of ['http://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test?key=secret',
    'https://api.example.test#secret', 'https://api.example.test?', 'https://api.example.test#', 'file:///tmp/provider',
    'https://api.example.test\n', 'https://api.example.test/path with spaces']) {
    assert.throws(() => createBeatAPIClient({ env: { ...ENV, BEATAPI_BASE_URL: value } }), expectCode('INVALID_BASE_URL'));
  }
  for (const value of [`${KEY}\r\nX-Injected: leak`, `Bearer ${KEY}`, 123]) {
    assert.throws(() => createBeatAPIClient({ env: { BEATAPI_API_KEY: value } }), expectCode('INVALID_API_KEY'));
  }
  assert.throws(() => createBeatAPIClient({ env: { ...ENV, BEAT_BROWSER_JEV_MODEL: 'bad\nmodel' } }), expectCode('INVALID_MODEL'));
});

test('network, provider bodies and malicious thrown properties never become error text; no retries', async () => {
  const questions = buildQuestions(actionSpace());
  const hostileError = {};
  Object.defineProperty(hostileError, 'code', { get() { throw new Error(KEY); } });
  for (const response of [() => { throw new Error(`Authorization: Bearer ${KEY}`); }, () => { throw hostileError; },
    () => new Response(`provider error ${KEY}`, { status: 429 })]) {
    let calls = 0;
    const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(client.decide({ state: {}, questions }), (error) => {
      assert.ok(['NETWORK_ERROR', 'PROVIDER_HTTP_ERROR'].includes(error.code));
      assert.ok(!error.message.includes(KEY));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(client.lastMetadata, null);
  }
});

test('redirect status and already redirected responses are rejected without following', async () => {
  const questions = buildQuestions(actionSpace());
  for (const makeResponse of [() => new Response(null, { status: 302, headers: { location: `https://outside.invalid/${KEY}` } }),
    () => { const response = jsonResponse(responseFor(questions)); Object.defineProperty(response, 'redirected', { value: true }); return response; }]) {
    let calls = 0;
    const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => { calls++; return makeResponse(); } });
    await assert.rejects(client.decide({ state: {}, questions }), expectCode('PROVIDER_REDIRECT'));
    assert.equal(calls, 1);
  }
});

test('oversized request and exact credential occurrence fail before any request', async () => {
  const questions = buildQuestions(actionSpace());
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse(responseFor(questions)); };
  const small = createBeatAPIClient({ env: ENV, fetchImpl, maxRequestBytes: 32 });
  await assert.rejects(small.decide({ state: {}, questions }), expectCode('REQUEST_TOO_LARGE'));
  const client = createBeatAPIClient({ env: ENV, fetchImpl });
  await assert.rejects(client.decide({ state: { goal: KEY }, questions }), expectCode('REQUEST_CONTAINS_SECRET'));
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(client.decide({ state: cyclic, questions }), expectCode('INVALID_REQUEST'));
  assert.equal(calls, 0);
});

test('streamed bytes and declared Content-Length are bounded even for adversarial responses', async () => {
  const questions = buildQuestions(actionSpace());
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); },
    cancel() { cancelled = true; },
  });
  const client = createBeatAPIClient({ env: ENV, maxResponseBytes: 1024,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.decide({ state: {}, questions }), expectCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  const declared = createBeatAPIClient({ env: ENV, maxResponseBytes: 1024,
    fetchImpl: async () => jsonResponse({}, { headers: { 'content-type': 'application/json', 'content-length': '10485760' } }) });
  await assert.rejects(declared.decide({ state: {}, questions }), expectCode('RESPONSE_TOO_LARGE'));
});

test('malformed, wrong-media, and invalid JEV response bodies are discarded', async () => {
  const questions = buildQuestions(actionSpace());
  for (const [makeResponse, code] of [
    [() => new Response(`not JSON ${KEY}`, { headers: { 'content-type': 'application/json' } }), 'INVALID_RESPONSE'],
    [() => new Response(`<html>${KEY}</html>`, { headers: { 'content-type': 'text/html' } }), 'INVALID_RESPONSE'],
    [() => jsonResponse({ choices: [{ message: { content: KEY } }] }), 'INVALID_DECISION'],
    [() => jsonResponse({ answers: { operation: { choice: KEY } } }), 'INVALID_DECISION'],
    [() => new Response(new Uint8Array([255, 255]), { headers: { 'content-type': 'application/json' } }), 'INVALID_RESPONSE'],
  ]) {
    const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => makeResponse() });
    await assert.rejects(client.decide({ state: {}, questions }), expectCode(code));
    assert.equal(client.lastMetadata, null);
  }
});

test('abort before fetch makes zero requests; abort and timeout never trigger retry', async () => {
  const questions = buildQuestions(actionSpace());
  let calls = 0;
  const aborted = new AbortController();
  aborted.abort(new Error(KEY));
  const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => { calls++; return new Promise(() => {}); }, timeoutMs: 20 });
  await assert.rejects(client.decide({ state: {}, questions, signal: aborted.signal }), expectCode('ABORTED'));
  assert.equal(calls, 0);
  await assert.rejects(client.decide({ state: {}, questions }), expectCode('TIMEOUT'));
  assert.equal(calls, 1);
  const active = new AbortController();
  const request = client.decide({ state: {}, questions, signal: active.signal });
  active.abort(new Error(KEY));
  await assert.rejects(request, expectCode('ABORTED'));
  assert.equal(calls, 2);
});

test('timeout includes a stalled response stream and cancels the reader', async () => {
  const questions = buildQuestions(actionSpace());
  let cancelled = false;
  const client = createBeatAPIClient({ env: ENV, timeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.decide({ state: {}, questions }), expectCode('TIMEOUT'));
  assert.equal(cancelled, true);
});

test('metadata allowlists numeric token counts and omits credential-bearing request IDs', async () => {
  const questions = buildQuestions(actionSpace());
  const raw = responseFor(questions);
  raw.id = `request-${KEY}`;
  raw.usage = { input_tokens: 100, output_tokens: '20', total_tokens: NaN, prompt_tokens: -1, completion_tokens: 20,
    headers: { Authorization: KEY }, provider_debug: KEY };
  const client = createBeatAPIClient({ env: ENV, fetchImpl: async () => jsonResponse(raw) });
  const result = await client.decide({ state: {}, questions });
  assert.equal(result.id, undefined);
  assert.deepEqual(result.usage, { input_tokens: 100, completion_tokens: 20 });
  const read = client.lastMetadata;
  read.usage.input_tokens = 999;
  assert.equal(client.lastMetadata.usage.input_tokens, 100);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('text helper uses explicit model and the same key, one request, bounded sanitized context', async () => {
  let calls = 0;
  const client = createBeatAPIClient({ env: TEXT_ENV, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.beatapi.io/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'explicit-text-model');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 512);
    assert.equal(body.state, undefined);
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.goal, 'Find blue shoes');
    assert.ok(!options.body.includes('person@example.test'));
    assert.ok(!options.body.includes('raw-private-value'));
    assert.deepEqual(Object.keys(context), ['goal', 'field', 'facts']);
    return jsonResponse(textResponse());
  } });
  const result = await client.generateText({ goal: 'Find blue shoes', target: { ...INPUT, value: 'raw-private-value' }, facts: ['Catalog updated by person@example.test'] });
  assert.equal(result, 'blue shoes');
  assert.equal(calls, 1);
  assert.deepEqual(client.lastMetadata, { id: 'text-offline-1', usage: { total_tokens: 58, prompt_tokens: 50, completion_tokens: 8 } });
});

test('text helper does not impose business-policy restrictions on caller-selected fields', async () => {
  let calls = 0;
  const client = createBeatAPIClient({ env: TEXT_ENV, fetchImpl: async () => { calls++; return jsonResponse(textResponse()); } });
  for (const name of ['Password', 'Full name', 'Email', 'Phone', 'Card number', 'Billing address', 'API key', 'Date of birth']) {
    assert.equal(await client.generateText({ goal: 'Fill this field', target: { ...INPUT, name } }), 'blue shoes');
  }
  assert.equal(await client.generateText({ goal: 'Invent a full name', target: INPUT }), 'blue shoes');
  assert.equal(calls, 9);
});

test('text helper accepts exactly one text property and rejects unsafe/ambiguous model output', async (t) => {
  const cases = {
    'markdown fences': '```json\n{"text":"shoes"}\n```',
    'additional action': '{"text":"shoes","action":"CLICK"}',
    'duplicate property': '{"text":"shoes","text":"different"}',
    'empty string': '{"text":" "}',
    'non-string': '{"text":123}',
    'null': 'null',
    'NUL': '{"text":"shoe\\u0000s"}',
    'too long': JSON.stringify({ text: 'x'.repeat(1001) }),
    'credential': JSON.stringify({ text: KEY }),
    'hidden credential spelling': JSON.stringify({ text: 'pass\u200bword=private123' }),
  };
  for (const [name, content] of Object.entries(cases)) {
    await t.test(name, async () => {
      let calls = 0;
      const client = createBeatAPIClient({ env: TEXT_ENV, fetchImpl: async () => { calls++; return jsonResponse(textResponse(content)); } });
      await assert.rejects(client.generateText({ goal: 'Find shoes', target: INPUT }), expectCode('INVALID_TEXT'));
      assert.equal(calls, 1);
      assert.equal(client.lastMetadata, null);
    });
  }
});

test('text helper may return caller-authorized identity, payment or credential-shaped text', async () => {
  const fullWidthPassword = String.fromCodePoint(0xff50, 0xff41, 0xff53, 0xff53, 0xff57, 0xff4f, 0xff52, 0xff44) + '=private123';
  for (const text of ['password=private123', 'person@example.test', '4111 1111 1111 1111', fullWidthPassword]) {
    const client = createBeatAPIClient({ env: TEXT_ENV, fetchImpl: async () => jsonResponse(textResponse(JSON.stringify({ text }))) });
    assert.equal(await client.generateText({ goal: 'Fill the selected field', target: INPUT }), text);
  }
});

test('text helper refuses truncated outputs, tool calls, and multiple choices', async () => {
  const values = [textResponse(), textResponse(), textResponse()];
  values[0].choices[0].finish_reason = 'length';
  values[1].choices[0].message.tool_calls = [{ function: { name: 'eval', arguments: KEY } }];
  values[2].choices.push(values[2].choices[0]);
  for (const raw of values) {
    const client = createBeatAPIClient({ env: TEXT_ENV, fetchImpl: async () => jsonResponse(raw) });
    await assert.rejects(client.generateText({ goal: 'Find shoes', target: INPUT }), expectCode('INVALID_TEXT'));
  }
});

test('text validator enforces structure without judging business content', () => {
  assert.equal(validateTextValue('  blue shoes  ', { target: INPUT }), '  blue shoes  ');
  assert.equal(validateTextValue('Alice Example', { target: { ...INPUT, name: 'Full name' } }), 'Alice Example');
  assert.equal(validateTextValue('4111 1111 1111 1111', { target: INPUT }), '4111 1111 1111 1111');
  assert.equal(validateTextValue('secret=example', { target: INPUT }), 'secret=example');
  assert.throws(() => validateTextValue('example', { target: { ...INPUT, name: 'Pass\u200bword' } }), expectCode('UNSAFE_TEXT_TARGET'));
});
