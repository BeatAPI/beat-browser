import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomains, assertAllowedUrl, buildActionSpace, guardDecision } from '../src/fast-agent/policy.js';
import { sanitizeText, sanitizeUrl, sanitizeSnapshot, sanitizeTraceEntry } from '../src/fast-agent/redact.js';

const DOMAINS = ['example.test'];
const button = (ref = 'e1', extra = {}) => ({ ref, role: 'button', name: 'Details', tagName: 'BUTTON', inputType: 'button', visible: true, disabled: false, readOnly: false, sensitive: false, risk: null, formRisk: null, operations: ['CLICK'], ...extra });
const input = (ref = 'e2', extra = {}) => button(ref, { role: 'searchbox', name: 'Search catalog', tagName: 'INPUT', inputType: 'search', operations: ['TYPE_TEXT'], ...extra });
const select = (extra = {}) => button('e3', { role: 'combobox', name: 'Color', tagName: 'SELECT', inputType: '', operations: ['SELECT'], options: [
  { id: 'e3:o0', index: 0, label: 'Red', disabled: false, selected: true },
  { id: 'e3:o1', index: 1, label: 'Blue', disabled: false, selected: false },
], ...extra });
const page = (elements = [button(), input(), select()], extra = {}) => ({ snapshotId: 's1', url: 'https://example.test/catalog', title: 'Catalog', visibleText: 'Browse products', elements, scroll: { up: false, down: true }, challenge: false, tabId: 1, ...extra });
const build = (snapshot) => buildActionSpace(snapshot, { allowedDomains: DOMAINS });
const code = (expected) => (error) => error?.code === expected && !error.message.includes('secret');

test('domain normalization permits only declared exact normalized hosts', () => {
  assert.deepEqual(normalizeDomains('https://EXAMPLE.test:8443/catalog', ['docs.example.test', 'EXAMPLE.test', 'b\u00fccher.test']), ['example.test', 'docs.example.test', 'xn--bcher-kva.test']);
  assert.equal(assertAllowedUrl('http://example.test:9090/products', DOMAINS).hostname, 'example.test');
  assert.equal(assertAllowedUrl('https://xn--bcher-kva.test/', ['b\u00fccher.test']).hostname, 'xn--bcher-kva.test');
  assert.throws(() => normalizeDomains('http://[::1]:3000/'), code('UNSAFE_URL'));
  assert.throws(() => normalizeDomains('https://example.test./'), code('UNSAFE_URL'));
  for (const url of ['https://sub.example.test/', 'https://example.test.evil.test/', 'https://evil-example.test/', 'https://example.test%2eevil.test/']) assert.throws(() => assertAllowedUrl(url, DOMAINS), code('DOMAIN_BLOCKED'));
});

test('invalid domain declarations cannot silently broaden scope', () => {
  for (const domain of ['*.example.test', '.example.test', 'https://example.test', 'example.test/path', 'example.test?x=1', 'example.test#x', 'example.test:443', 'user@example.test', 'example.test.', 'example.test..', '[::1]', ' example.test', 'example.test ', 'example%2etest', '', null]) {
    assert.throws(() => normalizeDomains('https://example.test/', [domain]), code('INVALID_DOMAINS'), String(domain));
  }
  assert.throws(() => normalizeDomains('https://example.test/', 'example.test'), code('INVALID_DOMAINS'));
  assert.throws(() => normalizeDomains('https://example.test/', Array(33).fill('example.test')), code('INVALID_DOMAINS'));
  assert.throws(() => normalizeDomains('https://example.test/', Array.from({ length: 32 }, (_, i) => `h${i}.test`)), code('INVALID_DOMAINS'));
  assert.throws(() => assertAllowedUrl('https://example.test/', []), code('INVALID_DOMAINS'));
});

test('normalized domain configuration is idempotent at the maximum scope size', () => {
  const domains = normalizeDomains('https://example.test/', Array.from({ length: 31 }, (_, index) => `h${index}.test`));
  assert.equal(domains.length, 32);
  assert.deepEqual(normalizeDomains('https://example.test/', domains), domains);
});

test('URL guard enforces technical scope without judging same-domain business semantics', () => {
  for (const suffix of ['/delete?id=42', '/checkout', '/settings/api-key', '/items#payment', '/%2564elete', '/%E5%88%A0%E9%99%A4', '/archive.zip', '/?action=send', '/login', '/profile', '/settings', '/verify']) {
    assert.equal(assertAllowedUrl(`https://example.test${suffix}`, DOMAINS).hostname, 'example.test');
  }
  assert.throws(() => assertAllowedUrl('https://example.test/?redirect=https://evil.test/', DOMAINS), code('UNSAFE_URL'));
});

test('URL guard rejects credentials, executable schemes, parser confusion and excessive input', () => {
  for (const url of ['javascript:alert(1)', 'data:text/plain,hello', 'file:///tmp/private', 'https://user:secret@example.test/', 'https://example.test@evil.test/']) assert.throws(() => assertAllowedUrl(url, DOMAINS), code('UNSAFE_URL'));
  for (const url of ['/relative', ' https://example.test/', 'https://example.test/\npath', 'https://example.test\\@evil.test/', `https://example.test/${'a'.repeat(9000)}`, null]) assert.throws(() => assertAllowedUrl(url, DOMAINS), code('INVALID_URL'));
});

test('action space has compatible opaque choices and bounded non-target actions', () => {
  const space = build(page());
  assert.deepEqual(space.operations, ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
  assert.deepEqual(Object.keys(space.targets.CLICK), ['e1']);
  assert.deepEqual(Object.keys(space.targets.TYPE_TEXT), ['e2']);
  assert.deepEqual(Object.keys(space.targets.SELECT), ['e3:o1']);
  assert.equal(space.targets.SELECT['e3:o1'].optionId, 'e3:o1');
  assert.equal(space.targets.SELECT['e3:o1'].ref, 'e3');
  assert.equal(space.targets.SELECT['e3:o1'].label, 'Blue');
  assert.deepEqual(space.excluded, []);
  assert.deepEqual(build(page([], { scroll: { up: true, down: false } })).operations, ['SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED']);
});

test('declared operations alone do not establish an element capability', () => {
  const fake = [
    button('e1', { tagName: 'SCRIPT', operations: ['CLICK', 'TYPE_TEXT', 'SELECT'] }),
    button('e2', { role: 'textbox', operations: ['TYPE_TEXT'] }),
    input('e3', { role: 'button', operations: ['CLICK'] }),
    input('e4', { inputType: 'number', operations: ['TYPE_TEXT'] }),
    button('e5', { tagName: 'DIV', role: 'button', operations: ['TYPE_TEXT'] }),
    button('e6', { tagName: 'DIV', role: 'combobox', operations: ['SELECT'], options: [{ id: 'e6:o0', index: 0, label: 'Blue' }] }),
    button('e7', { tagName: 'A', role: 'link', href: undefined }),
    button('e8', { operations: [] }),
  ];
  const space = build(page(fake));
  assert.deepEqual(space.operations, ['TYPE_TEXT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
  assert.deepEqual(Object.keys(space.targets.TYPE_TEXT), ['e4']);
  assert.equal(space.excluded.length, fake.length - 1);
});

test('visibility and capability exclude targets while business metadata does not', () => {
  const elements = [button('e1', { visible: false }), button('e2', { visible: undefined }), button('e3', { disabled: true }), input('e4', { readOnly: true }), button('e5', { sensitive: true }), button('e6', { risk: 'payment' }), button('e7', { formRisk: 'sensitive-form' }), button('e8', { download: true })];
  const space = build(page(elements));
  assert.equal(space.excluded.length, 4);
  assert.deepEqual(Object.keys(space.targets.CLICK), ['e5', 'e6', 'e7', 'e8']);
  assert.equal(Object.keys(space.targets.TYPE_TEXT).length, 0);
});

test('business action labels are all eligible when the caller offers them', () => {
  const allowed = ['Reply', 'Post', 'Send message', 'Publish', 'Submit', 'Confirm', 'Continue', 'Save changes', 'Sign in', 'Update profile', 'Open settings', 'Verify', 'Start', 'OK'];
  const allowedSpace = build(page(allowed.map((name, i) => button(`e${i + 1}`, { name }))));
  assert.deepEqual(Object.keys(allowedSpace.targets.CLICK), allowed.map((_, i) => `e${i + 1}`));

  const labels = ['Pay now', 'Place order', 'Delete item', 'Credentials', 'Make payment', 'API key', 'deleteAccount', 'Place_order', 'PAY\u200bMENT'];
  const space = build(page(labels.map((name, i) => button(`e${i + 1}`, { name }))));
  assert.equal(space.excluded.length, 0);
  assert.deepEqual(Object.keys(space.targets.CLICK), labels.map((_, i) => `e${i + 1}`));
});

test('multilingual business actions are eligible while symbol-only labels remain unsupported', () => {
  const allowed = ['\u56de\u590d', '\u53d1\u5e03\u56de\u590d', '\u9001\u4fe1', 'Enviar'];
  const allowedSpace = build(page(allowed.map((name, index) => button(`e${index + 1}`, { name }))));
  assert.deepEqual(Object.keys(allowedSpace.targets.CLICK), allowed.map((_, index) => `e${index + 1}`));
  const labels = ['\u5220\u9664', '\u652f\u4ed8', '\u0423\u0434\u0430\u043b\u0438\u0442\u044c', 'L\u00f6schen', 'P\u0430y', '\ud83d\udcb8', 'Pagar', 'Comprar', 'Supprimer', 'Bezahlen'];
  assert.deepEqual(Object.keys(build(page(labels.map((name, index) => button(`e${index + 1}`, { name })))).targets.CLICK), ['e1', 'e2', 'e3', 'e4', 'e5', 'e7', 'e8', 'e9', 'e10']);
  const localizedOption = select({ options: [{ id: 'e3:o0', index: 0, label: '\u5220\u9664', disabled: false, selected: false }] });
  assert.deepEqual(Object.keys(build(page([localizedOption])).targets.SELECT), ['e3:o0']);
  assert.ok(build(page([button('e1', { name: '\u641c\u7d22 \ud83d\udd0d' })])).targets.CLICK.e1);
});

test('caller-controlled identity and credential fields are typeable when technically supported', () => {
  const labels = ['Full name', 'First name', 'Last name', 'Your name', 'Email', 'E-mail', 'Phone', 'Mobile', 'Address', 'Date of birth', 'Passport', 'SSN', 'Card number', 'CVV', 'OTP', 'PIN', 'Bank', 'Password', 'Access token'];
  const elements = labels.map((name, i) => input(`e${i + 1}`, { name, value: 'safe user supplied input' }));
  for (const type of ['password', 'email', 'tel', 'file', 'hidden', 'submit', 'reset', 'image']) elements.push(input(`e${elements.length + 1}`, { name: 'Search', inputType: type }));
  assert.equal(Object.keys(build(page(elements)).targets.TYPE_TEXT).length, 22);
});

test('form metadata does not impose business-policy restrictions', () => {
  for (const extra of [{ formLabel: 'Payment form' }, { formAction: '/account/save' }, { autocomplete: 'cc-number' }, { placeholder: 'Enter password' }, { ariaDescription: 'Email address' }]) {
    assert.equal(Object.keys(build(page([input('e1', extra)])).targets.TYPE_TEXT).length, 1, JSON.stringify(extra));
  }
});

test('same-domain links are clickable regardless of business meaning', () => {
  const link = (ref, href, extra = {}) => button(ref, { tagName: 'A', inputType: '', role: 'link', name: 'Details', href, ...extra });
  const elements = [link('e1', '/products/1'), link('e2', 'https://sub.example.test/'), link('e3', 'javascript:alert(1)'), link('e4', '/items?action=delete'), link('e5', '/%70ayments'), link('e6', '/items?redirect=https://evil.test/'), link('e7', '/archive.zip'), link('e8', '//evil.test/'), link('e9', '/%ZZ'), link('e10', '/page/2', { name: 'Next' })];
  const space = build(page(elements));
  assert.ok(space.targets.CLICK.e1);
  for (const ref of ['e1', 'e4', 'e5', 'e7', 'e9', 'e10']) assert.ok(space.targets.CLICK[ref], ref);
  for (const ref of ['e2', 'e3', 'e6', 'e8']) assert.equal(space.targets.CLICK[ref], undefined, ref);
});

test('native submit controls are eligible through the same opaque click interface', () => {
  for (const tagName of ['INPUT', 'BUTTON']) assert.ok(build(page([button('e1', { name: 'Reply', tagName, inputType: 'submit' })])).targets.CLICK.e1);
});

test('contenteditable textboxes use the same exact-input interface as ordinary text fields', () => {
  const editor = button('e1', { tagName: 'DIV', role: 'textbox', inputType: '', operations: ['TYPE_TEXT'] });
  assert.ok(build(page([editor])).targets.TYPE_TEXT.e1);
});

test('SELECT binds each legal choice to one native ref and enabled option index', () => {
  const native = select({ options: [
    { id: 'e3:o0', index: 0, label: 'Red', selected: true },
    { id: 'e3:o1', index: 1, label: 'Blue' },
    { id: 'e3:o2', index: 2, label: 'Green', disabled: true },
    { id: 'e3:o3', index: 3, label: 'Delete account' },
    { id: 'e4:o4', index: 4, label: 'Other' },
    { id: 'e3:o9', index: 5, label: 'Mismatched index' },
    { id: '__proto__', index: 6, label: 'Prototype' },
    { id: 'e3:o7', index: 7, label: 'Duplicate' },
    { id: 'e3:o7', index: 7, label: 'Duplicate' },
  ] });
  assert.deepEqual(Object.keys(build(page([native])).targets.SELECT), ['e3:o1', 'e3:o3']);
});

test('duplicate opaque refs and malformed snapshots fail closed', () => {
  assert.deepEqual(Object.keys(build(page([button(), button()])).targets.CLICK), []);
  for (const snapshot of [null, {}, page([], { snapshotId: '' }), page([], { elements: Array(2001).fill(button()) })]) assert.throws(() => build(snapshot), code('INVALID_SNAPSHOT'));
  assert.throws(() => build(page([], { url: 'https://evil.test/' })), code('DOMAIN_BLOCKED'));
  assert.throws(() => build(page([], { challenge: true })), code('PAGE_CHALLENGE'));
  assert.deepEqual(build(page([], { url: 'https://example.test/settings/api-key' })).operations, ['SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
});

test('guard rechecks scope, snapshot identity, current safety and original target identity', () => {
  const snapshot = page();
  const space = build(snapshot);
  const decision = { operation: 'CLICK', targetId: 'e1', snapshotId: 's1', confidence: 0.95, operationConfidence: 0.95, targetConfidence: 1 };
  assert.equal(guardDecision(decision, space, snapshot, DOMAINS).ref, 'e1');
  assert.equal(guardDecision({ operation: 'SELECT', targetId: 'e3:o1', snapshotId: 's1' }, space, snapshot, DOMAINS).optionId, 'e3:o1');
  assert.equal(guardDecision({ operation: 'DONE', snapshotId: 's1' }, space, snapshot, DOMAINS), null);
  assert.throws(() => guardDecision({ ...decision, snapshotId: 's2' }, space, snapshot, DOMAINS), code('STALE_SNAPSHOT'));
  assert.throws(() => guardDecision(decision, space, page([], { url: 'https://evil.test/' }), DOMAINS), code('DOMAIN_BLOCKED'));
  assert.throws(() => guardDecision(decision, space, page([button('e1', { name: 'Delete item' })]), DOMAINS), code('TARGET_BLOCKED'));
  assert.throws(() => guardDecision(decision, space, page([button('e1', { name: 'Other details' })]), DOMAINS), code('TARGET_BLOCKED'));
  const forged = structuredClone(space);
  forged.targets.CLICK.e1.ref = 'e2';
  assert.throws(() => guardDecision(decision, forged, snapshot, DOMAINS), code('TARGET_BLOCKED'));
});

test('model output cannot add execution channels or target unsupported heads', () => {
  const snapshot = page();
  const space = build(snapshot);
  for (const extra of [{ url: 'https://evil.test/' }, { selector: '#secret' }, { code: 'alert(1)' }, { text: 'submit' }, { coordinates: [1, 2] }, { confidence: NaN }, { targetConfidence: 2 }]) assert.throws(() => guardDecision({ operation: 'CLICK', targetId: 'e1', ...extra }, space, snapshot, DOMAINS), code('INVALID_DECISION'));
  for (const operation of ['NAVIGATE', 'EVAL', 'FETCH', 'SHELL', 'SCREENSHOT']) assert.throws(() => guardDecision({ operation }, space, snapshot, DOMAINS), code('INVALID_DECISION'));
  assert.throws(() => guardDecision({ operation: 'TYPE_TEXT', targetId: 'e1' }, space, snapshot, DOMAINS), code('TARGET_BLOCKED'));
  assert.throws(() => guardDecision({ operation: 'SELECT', targetId: 'e3' }, space, snapshot, DOMAINS), code('TARGET_BLOCKED'));
  assert.throws(() => guardDecision({ operation: 'WAIT', targetId: 'e1' }, space, snapshot, DOMAINS), code('INVALID_DECISION'));
  assert.throws(() => guardDecision({ operation: 'SCROLL_UP' }, space, snapshot, DOMAINS), code('OPERATION_BLOCKED'));
});

test('text sanitizer masks credentials, private keys, contact data and long identifiers', () => {
  const fakeProjectKey = 'sk-proj-' + 'abcd' + '1234567890'.repeat(2);
  const samples = [
    ['Authorization: Bearer sk_test_never_print_123', 'sk_test_never_print_123'],
    ['password = correct horse battery staple', 'correct horse battery staple'],
    ['Bearer secret-with-dashes', 'secret-with-dashes'],
    ['Token: short value words', 'short value words'],
    [`key ${fakeProjectKey}`, fakeProjectKey],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqb2huIn0.signature123', 'eyJhbGciOiJIUzI1NiJ9'],
    ['Contact john.smith@example.test', 'john.smith@example.test'],
    ['Call +1 (415) 555-0123', '555-0123'],
    ['Card 4242 4242 4242 4242', '4242'],
    ['Name: John Smith', 'John Smith'],
    ['id 123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b'],
    ['SECRET_API_KEY_DO_NOT_LEAK', 'SECRET_API_KEY_DO_NOT_LEAK'],
    ['-----BEGIN PRIVATE KEY-----\nabcde\n-----END PRIVATE KEY-----', 'abcde'],
  ];
  for (const [source, forbidden] of samples) assert.ok(!sanitizeText(source, 2000).includes(forbidden), source);
  assert.equal(sanitizeText('Ordinary product details'), 'Ordinary product details');
  assert.equal(sanitizeText('Payment card password'), 'Payment card password');
  assert.equal(sanitizeText({ toString: () => 'unsafe' }), '');
});

test('URL sanitizer removes userinfo, query, fragment and arbitrary path identifiers', () => {
  const url = 'https://alice:secret@example.test/users/John-Smith/123456?token=secret#private';
  assert.equal(sanitizeUrl(url), 'https://example.test/[path]');
  assert.equal(sanitizeText(`Open ${url}`), 'Open https://example.test/[path]');
  assert.equal(sanitizeUrl('https://example.test/'), 'https://example.test/');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '[redacted-url]');
  assert.equal(sanitizeUrl(null), '[redacted-url]');
});

test('sanitized cloud snapshot contains explicit bounded fields and never raw element values', () => {
  const secret = 'sk_test_never_print_123';
  const raw = page([
    input('e1', { value: 'typed ordinary words', arbitrary: secret, attributes: { token: secret }, href: 'https://example.test/user/Jane?secret=raw' }),
    input('e2', { name: 'Password', value: secret, sensitive: false }),
    input('e3', { name: 'Search', value: secret, risk: 'sensitive-form' }),
    input('e4', { visible: false, value: secret }),
    select({ options: [{ id: 'e3:o0', index: 0, label: 'Blue', value: secret, arbitrary: secret }] }),
  ], { url: 'https://user:secret@example.test/user/John?token=raw#private', visibleText: `Hello john@example.test ${secret}`, cookies: secret, storage: secret, headers: { authorization: secret }, screenshot: secret });
  const clean = sanitizeSnapshot(raw);
  const json = JSON.stringify(clean);
  for (const forbidden of [secret, 'typed ordinary words', 'john@example.test', 'cookies', 'storage', 'headers', 'screenshot', 'arbitrary', 'attributes', '"value":', 'user:secret', 'token=raw', '/John']) assert.ok(!json.includes(forbidden), forbidden);
  assert.deepEqual(clean.elements.map((element) => element.ref), ['e1', 'e3']);
  assert.equal(clean.url, 'https://example.test/[path]');
  assert.equal(clean.tabId, undefined);
  assert.equal(clean.elements[0].valuePresent, true);
  assert.equal(sanitizeSnapshot(page([input('e1', { value: '' })])).elements[0].valuePresent, false);
});

test('redaction bounds input and output structures against oversized page data', () => {
  assert.equal(sanitizeText('a'.repeat(200000), 10).length, 10);
  assert.equal(sanitizeText('a', -1), '');
  assert.ok(sanitizeText('x '.repeat(100000), 999999).length <= 20000);
  const clean = sanitizeSnapshot(page(Array.from({ length: 1000 }, (_, index) => input(`e${index + 1}`, { name: 'ordinary '.repeat(1000) })), { title: 'word '.repeat(10000), visibleText: 'word '.repeat(10000) }));
  assert.equal(clean.elements.length, 200);
  assert.ok(clean.title.length <= 200);
  assert.ok(clean.visibleText.length <= 6000);
  assert.ok(clean.elements.every((element) => element.name.length <= 160));
});

test('trace schema preserves useful numeric metadata while hashing free request identifiers', () => {
  const trace = sanitizeTraceEntry({ time: '2026-09-20T09:30:01Z', step: 3, operation: 'CLICK', ref: 'e1', targetRole: 'button', targetName: 'John Smith', confidence: 0.9, requestId: 'provider-request-123', probabilities: { operation: { CLICK: 0.9, DONE: 0.1 }, target: { e1: 1 } }, usage: { prompt_tokens: 40, completion_tokens: 3 }, pageChanged: true, retry: 0, stale: false, status: 'executed', verification: { verified: true, checks: [{ index: 0, passed: true }] }, final: true });
  assert.equal(trace.targetName, '[button target]');
  assert.match(trace.requestId, /^sha256:[a-f0-9]{24}$/);
  assert.equal(trace.time, '2026-09-20T09:30:01.000Z');
  assert.deepEqual(trace.probabilities.target, { e1: 1 });
  assert.deepEqual(trace.usage, { prompt_tokens: 40, completion_tokens: 3 });
  assert.equal(trace.status, 'executed');
  assert.deepEqual(trace.verification, { verified: true, checks: [{ index: 0, passed: true }] });
});

test('malicious provider metadata cannot smuggle API keys or nested text into traces', () => {
  const secret = 'sk_test_never_print_123';
  const trace = sanitizeTraceEntry({
    time: secret, step: secret, operation: secret, ref: secret, targetId: secret, targetRole: secret, targetName: secret, confidence: secret, requestId: secret,
    raw: secret, body: secret, text: secret, goal: secret, inputs: [secret], headers: { authorization: secret }, metadata: { arbitrary: secret }, status: secret, blockedReason: secret,
    probabilities: { operation: { CLICK: 1, [secret]: 0 }, target: { e1: 0.9, 'e2:o1': 0.1, [secret]: 0, e3: secret }, extra: secret },
    usage: { prompt_tokens: 4, total_tokens: secret, extra: secret, [secret]: 1 },
    verification: { verified: true, reason: secret, checks: [{ index: 0, passed: true, text: secret }, { index: 1, passed: secret }] },
  });
  assert.ok(!JSON.stringify(trace).includes(secret));
  assert.equal(trace.blockedReason, 'REDACTED_REASON');
  assert.deepEqual(trace.probabilities, { operation: { CLICK: 1 }, target: { e1: 0.9, 'e2:o1': 0.1 } });
  assert.deepEqual(trace.usage, { prompt_tokens: 4 });
  assert.deepEqual(trace.verification.checks, [{ index: 0, passed: true }]);
});

test('trace validation rejects prototype objects, nonfinite numbers and unrecognized choices', () => {
  const inherited = Object.create({ operation: 'CLICK' });
  assert.deepEqual(sanitizeTraceEntry(inherited), {});
  const trace = sanitizeTraceEntry({ step: Infinity, confidence: NaN, usage: { prompt_tokens: -1 }, probabilities: { operation: { CLICK: Infinity, EVAL: 1 }, target: { selector: 1, e1: -1, e2: 2 } }, changed: 'true', retry: -1, status: 'model_response', blockedReason: 'LOW_CONFIDENCE' });
  assert.deepEqual(trace, { probabilities: { operation: {}, target: {} }, usage: {}, status: 'model_response', blockedReason: 'LOW_CONFIDENCE' });
});
