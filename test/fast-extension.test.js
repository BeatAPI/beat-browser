import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentHarness } from './fast-extension-dom-helper.js';

function buttonFixture() {
  const h = createContentHarness();
  const button = h.el('button', { type: 'button', id: 'details' }, 'Show details');
  h.document.body.append(button);
  h.document.hit = button;
  return { h, button };
}

function actionParams(h, snapshot, operation, ref, extra = {}) {
  return { ...h.config, snapshotId: snapshot.snapshotId, expectedUrl: snapshot.url, operation,
    ...(ref ? { ref } : {}), ...extra };
}

test('structured snapshot is bounded and masks private values, hidden text and URLs', async () => {
  const h = createContentHarness({ title: 'Fixture person@example.test' });
  const hidden = h.el('div', {}, 'NEVER-HIDDEN-TEXT'); hidden.hidden = true;
  hidden.append(h.el('button', { type: 'button' }, 'Hidden control'));
  const password = h.el('input', { type: 'password', id: 'password', value: 'my-unique-password' });
  const email = h.el('input', { type: 'email', name: 'email', value: 'person@example.test' });
  const identity = h.el('input', { name: 'full_name', value: 'Private Person' });
  const card = h.el('input', { name: 'card_number', value: '4111111111111111' });
  const label = h.el('div', { id: 'hidden-label' }, 'HIDDEN-LABEL-SECRET'); label.hidden = true;
  const field = h.el('input', { name: 'query', 'aria-labelledby': 'hidden-label' });
  const link = h.el('a', { href: '/details?token=do-not-export#private' }, 'Details');
  h.document.body.append(hidden, password, email, identity, card, label, field, link,
    h.el('p', {}, 'Public my-unique-password person@example.test Private Person 4111111111111111'));
  const snapshot = await h.snapshot();
  const encoded = JSON.stringify(snapshot);
  for (const secret of ['NEVER-HIDDEN-TEXT', 'Hidden control', 'HIDDEN-LABEL-SECRET', 'my-unique-password', 'person@example.test', 'Private Person', '4111111111111111', '?token=', '#private']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(snapshot.url, 'https://example.test/start');
  assert.equal(snapshot.elements.find((element) => element.role === 'link').href, 'https://example.test/details');
  assert(snapshot.elements.every((element) => element.visible === true));
  assert(snapshot.elements.filter((element) => element.sensitive).every((element) => element.operations.length === 0));
});

test('snapshot limits elements, options and visible text without exposing option values', async () => {
  const h = createContentHarness();
  const select = h.el('select', { name: 'color' });
  select.append(...Array.from({ length: 90 }, (_, i) => h.el('option', { value: `native-option-secret-${i}` }, `Color ${i}`)));
  h.document.body.append(select, h.el('p', {}, 'Visible '.repeat(2000)),
    ...Array.from({ length: 220 }, (_, i) => h.el('button', { type: 'button' }, `Item ${i}`)));
  const snapshot = await h.snapshot();
  assert.equal(snapshot.elements.length, 160);
  assert.equal(snapshot.elements[0].options.length, 60);
  assert(snapshot.visibleText.length <= 6000);
  assert.equal(JSON.stringify(snapshot).includes('native-option-secret'), false);
});

test('exact domain scope is checked before structured observation', async () => {
  const h = createContentHarness({ url: 'https://sub.example.test/page' });
  assert.equal((await h.snapshot()).blockedReason, 'domain-out-of-scope');
  assert.equal((await h.snapshot({ allowedDomains: ['*.example.test'] })).blockedReason, 'malformed-request');
  const file = createContentHarness({ url: 'file:///tmp/private.html' });
  assert.equal((await file.snapshot()).blockedReason, 'domain-out-of-scope');
});

test('top-frame-only mode rejects an iframe and detected challenges', async () => {
  const h = createContentHarness(); h.window.top = {};
  assert.equal((await h.snapshot()).blockedReason, 'unsupported-frame');
  const challenge = createContentHarness(); challenge.document.body.append(challenge.el('p', {}, 'Please verify that you are human'));
  const result = await challenge.snapshot();
  assert.equal(result.blockedReason, 'challenge'); assert.equal(result.challenge, true);
});

test('business actions and downloads are eligible while technical scope violations remain blocked', async () => {
  const h = createContentHarness();
  const form = h.el('form', { action: '/billing' }); form.append(h.el('input', { name: 'amount' }), h.el('button', {}, 'Continue'));
  const reply = h.el('button', { type: 'submit', id: 'reply' }, 'Reply');
  const send = h.el('button', { type: 'button', id: 'send' }, 'Send message');
  h.document.body.append(form, reply, send,
    h.el('a', { href: 'https://other.test/list' }, 'External'), h.el('a', { href: '/list', target: '_blank' }, 'New tab'),
    h.el('a', { href: 'javascript:alert(1)' }, 'Unsafe'), h.el('a', { href: '/report.csv' }, 'Report'),
    h.el('a', { href: '/list', download: '' }, 'Local report'));
  const snapshot = await h.snapshot();
  assert(snapshot.elements.length >= 9);
  const replyRow = snapshot.elements.find((element) => element.name === 'Reply');
  const sendRow = snapshot.elements.find((element) => element.name === 'Send message');
  assert.deepEqual(replyRow.operations, ['CLICK']);
  assert.equal(replyRow.risk, null);
  assert.deepEqual(sendRow.operations, ['CLICK']);
  assert.equal(sendRow.risk, null);
  for (const name of ['amount', 'Continue', 'Report', 'Local report']) {
    const row = snapshot.elements.find((element) => element.name === name);
    assert(row.operations.length > 0, name);
    assert.equal(row.risk, null, name);
  }
  for (const name of ['External', 'New tab', 'Unsafe']) {
    const row = snapshot.elements.find((element) => element.name === name);
    assert(row.risk && !row.operations.length, name);
  }
  assert.equal(snapshot.elements[0].formRisk, null);
});

test('an approved native submit click dispatches exactly once', async () => {
  const h = createContentHarness();
  const reply = h.el('button', { type: 'submit', id: 'reply' }, 'Reply');
  h.document.body.append(reply); h.document.hit = reply;
  const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, undefined);
  assert.deepEqual(h.actions, [{ type: 'click', id: 'reply' }]);
});

test('ordinary click dispatches once and never invokes dropdown or L2 retries', async () => {
  const { h, button } = buttonFixture();
  button.setAttribute('role', 'combobox'); button.setAttribute('aria-expanded', 'false');
  const arrow = h.el('span', { class: 'arrow' }); button.append(arrow);
  const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, undefined);
  assert.deepEqual(h.actions, [{ type: 'click', id: 'details' }]);
  assert.equal(result.pageChanged, false);
  assert.equal(Object.hasOwn(result, 'note'), false);
  const replay = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(replay.blockedReason, 'stale-snapshot');
  assert.equal(h.actions.length, 1);
});

test('native typing writes only the caller text and never focuses or submits', async () => {
  const h = createContentHarness(); const field = h.el('input', { type: 'search', name: 'query' });
  h.document.body.append(field); h.document.hit = field;
  const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'TYPE_TEXT', snapshot.elements[0].ref, { text: 'ordinary query' }));
  assert.equal(field.value, 'ordinary query'); assert.equal(result.pageChanged, true);
  assert.deepEqual(h.actions, [{ type: 'input', id: '' }]);
  assert.equal(JSON.stringify(result).includes('ordinary query'), false);
});

test('contenteditable typing pastes the exact caller text', async () => {
  const h = createContentHarness(); const field = h.el('div', { role: 'textbox', contenteditable: 'true', 'aria-label': 'Post reply', id: 'reply-box' });
  field.isContentEditable = true;
  field.addEventListener('paste', (event) => { field.innerText = event.clipboardData.getData('text/plain'); });
  h.document.body.append(field); h.document.hit = field;
  const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'TYPE_TEXT', snapshot.elements[0].ref, { text: 'first line\n\nsecond line' }));
  assert.equal(result.blockedReason, undefined);
  assert.equal(field.innerText, 'first line\n\nsecond line');
});

test('native SELECT addresses a saved option identity, including duplicate values', async () => {
  const h = createContentHarness(); const select = h.el('select', { name: 'color' });
  select.append(h.el('option', { value: 'duplicate' }, 'Red'), h.el('option', { value: 'duplicate' }, 'Blue'));
  h.document.body.append(select); h.document.hit = select;
  const snapshot = await h.snapshot(); const row = snapshot.elements[0];
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'SELECT', row.ref, { optionId: row.options[1].id }));
  assert.equal(select.selectedIndex, 1); assert.equal(result.blockedReason, undefined);
  assert.deepEqual(h.actions, [{ type: 'change', id: '' }]);
  assert.equal(JSON.stringify(result).includes('duplicate'), false);
});

test('unknown refs, selectors, extra text, wrong option IDs and no snapshot are zero-action rejects', async () => {
  const { h } = buttonFixture(); const snapshot = await h.snapshot(); const ref = snapshot.elements[0].ref;
  const cases = [
    { operation: 'CLICK', ref: 'e999' }, { operation: 'CLICK', ref: `${ref}@f2` },
    { operation: 'CLICK', ref, selector: '#details' }, { operation: 'CLICK', ref, text: 'unexpected' },
    { operation: 'EVAL', ref }, { operation: 'CLICK', ref, snapshotId: undefined },
    { operation: 'SELECT', ref, optionId: `${ref}:o01` }, { operation: 'SCROLL_DOWN', ref },
    { operation: 'CLICK', ref, submit: true }, { operation: 'CLICK', ref, url: 'https://other.test/' },
  ];
  for (const change of cases) {
    const result = await h.rpc('fast_act', { ...actionParams(h, snapshot, 'CLICK', ref), ...change });
    assert(result.blockedReason, JSON.stringify(change));
  }
  assert.equal(h.actions.length, 0);
});

test('selected-target mutations after observation, including property-only changes, invalidate the decision', async (t) => {
  const mutations = [
    (h, button) => button.setAttribute('aria-label', 'Replacement'),
    (h, button) => { button.readOnly = true; },
    (h, button) => { button.value = 'Changed without mutation record'; },
    (h, button) => { button.remove(); h.document.body.append(h.el('button', { type: 'button', id: 'details' }, 'Show details')); },
    (h) => { h.location.href = 'https://example.test/start?filter=different'; },
    (h) => { h.window.scrollY = 10; },
  ];
  for (let i = 0; i < mutations.length; i++) await t.test(`mutation ${i + 1}`, async () => {
    const { h, button } = buttonFixture(); const snapshot = await h.snapshot(); mutations[i](h, button);
    const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
    assert.equal(result.blockedReason, 'stale-snapshot'); assert.equal(h.actions.length, 0);
  });
});

test('unrelated DOM churn does not invalidate a stable visible target', async () => {
  const { h } = buttonFixture(); const snapshot = await h.snapshot();
  h.document.body.append(h.el('p', {}, 'New DOM context'));
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, undefined); assert.equal(h.actions.length, 1);
});

test('same-name href or form-context replacements after model observation are rejected', async () => {
  const h = createContentHarness(); const link = h.el('a', { href: '/safe' }, 'Details'); h.document.body.append(link); h.document.hit = link;
  const snapshot = await h.snapshot(); link.setAttribute('href', 'https://other.test/buy');
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, 'stale-snapshot'); assert.equal(h.actions.length, 0);
  const field = h.el('input', { name: 'query' }); const form = h.el('form', { action: '/search' }); form.append(field); h.document.body.append(form);
  const current = await h.snapshot(); form.setAttribute('action', '/checkout'); h.document.hit = field;
  const typed = await h.rpc('fast_act', actionParams(h, current, 'TYPE_TEXT', current.elements.find((row) => row.name === 'query').ref, { text: 'some query' }));
  assert.equal(typed.blockedReason, 'stale-snapshot'); assert.equal(field.value, '');
});

test('freshness is checked again after async baseline and before any mutation', async () => {
  const { h, button } = buttonFixture(); const snapshot = await h.snapshot();
  const pending = h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  setTimeout(() => { button.readOnly = true; }, 5);
  const result = await pending;
  assert.equal(result.blockedReason, 'stale-snapshot'); assert.equal(h.actions.length, 0);
});

test('abort during async baseline stops a pending action before dispatch', async () => {
  const { h } = buttonFixture(); const snapshot = await h.snapshot();
  const pending = h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await h.rpc('fast_abort', { runId: h.config.runId })).aborted, true);
  const result = await pending;
  assert.equal(result.blockedReason, 'aborted'); assert.equal(h.actions.length, 0);
});

test('a deadline crossed during baseline causes no action', async () => {
  const { h } = buttonFixture(); h.config.deadline = Date.now() + 25;
  const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, 'deadline-exceeded'); assert.equal(h.actions.length, 0);
});

test('concurrent decisions cannot consume a snapshot twice', async () => {
  const { h } = buttonFixture(); const snapshot = await h.snapshot();
  const params = actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref);
  const results = await Promise.all([h.rpc('fast_act', params), h.rpc('fast_act', params)]);
  assert.equal(results.filter((result) => result.blockedReason === 'stale-snapshot').length, 1);
  assert.equal(h.actions.filter((action) => action.type === 'click').length, 1);
});

test('verification reads fresh DOM, requires AND, returns no actual values, and rejects malformed conditions', async () => {
  const h = createContentHarness(); const field = h.el('input', { id: 'query', name: 'query', value: 'initial' });
  const check = h.el('input', { id: 'filter', type: 'checkbox' }); check.checked = true;
  const message = h.el('p', {}, 'Results ready'); const hidden = h.el('div', { id: 'hidden' }, 'Hidden evidence'); hidden.hidden = true;
  h.document.body.append(field, check, message, hidden); await h.snapshot(); field.value = 'updated-local-value';
  const valid = await h.rpc('fast_verify', { ...h.config, assertions: [
    { urlContains: '/start' }, { selectorExists: '#query' }, { textContains: 'Results ready' },
    { selector: '#query', value: 'updated-local-value' }, { selector: '#filter', checked: true }, { state: 'ready' },
  ] });
  assert.equal(valid.verified, true); assert.equal(valid.checks.length, 6);
  assert.equal(JSON.stringify(valid).includes('updated-local-value'), false);
  for (const assertions of [[], [{}], [{ selectorExists: '#hidden' }], [{ textContains: '' }], [{ selector: '#query', value: 'wrong' }], [{ urlContains: '/start', textContains: 'Results' }], [{ state: 'ready' }, { selectorExists: '#missing' }]]) {
    const result = await h.rpc('fast_verify', { ...h.config, assertions }); assert.equal(result.verified, false);
  }
  assert.equal(h.actions.length, 0);
});

test('scroll dispatch is fixed and bounded, then consumes its snapshot', async () => {
  const h = createContentHarness(); const snapshot = await h.snapshot();
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'SCROLL_DOWN'));
  assert.equal(result.pageChanged, true); assert.deepEqual(h.actions, [{ type: 'scroll', amount: 600 }]);
});

test('manual snapshot format and refs remain available without a fast run', async () => {
  const { h } = buttonFixture(); const manual = await h.rpc('snapshot');
  assert.match(manual.text, /\[e1\].*Show details/); assert.match(manual.snapshotId, /^s\d+$/);
  assert.equal(manual.untrusted, true);
});


test('same-domain routes remain observable regardless of business semantics', async () => {
  for (const path of ['/settings/api-keys', '/settings/password', '/checkout', '/profile', '/view?action=delete']) {
    const h = createContentHarness({ url: `https://example.test${path}` });
    h.document.body.append(h.el('p', {}, 'short-standalone-secret'));
    const result = await h.snapshot();
    assert.equal(result.blockedReason, undefined, path);
    assert.equal(result.url, new URL(`https://example.test${path}`).origin + new URL(`https://example.test${path}`).pathname);
  }
});

test('same-domain link semantics do not impose a business-policy restriction', async () => {
  const h = createContentHarness();
  const paths = ['/view?operation=delete&id=1', '/view?token=shortsecret', '/view?action=%EF%BD%90%EF%BD%81%EF%BD%99', '/view?action=de%E2%80%8Blete'];
  h.document.body.append(...paths.map((href) => h.el('a', { href }, 'Details')));
  const snapshot = await h.snapshot();
  assert.equal(snapshot.elements.length, paths.length);
  assert(snapshot.elements.every((row) => row.risk === null && row.operations.includes('CLICK')));
  assert.equal(JSON.stringify(snapshot).includes('shortsecret'), false);
});

test('same-domain posting and messaging routes are eligible', async () => {
  const h = createContentHarness();
  h.document.body.append(h.el('a', { href: '/compose/post' }, 'Post'), h.el('a', { href: '/view#send-message' }, 'Send message'));
  const snapshot = await h.snapshot();
  assert(snapshot.elements.every((row) => row.risk === null && row.operations.includes('CLICK')));
});


test('type and select allow page-owned follow-up events', async (t) => {
  for (const operation of ['TYPE_TEXT', 'SELECT']) await t.test(operation, async () => {
    const h = createContentHarness();
    const field = operation === 'TYPE_TEXT' ? h.el('input', { name: 'query', type: 'search' }) : h.el('select', { name: 'color' });
    if (operation === 'SELECT') field.append(h.el('option', { value: 'one' }, 'One'), h.el('option', { value: 'two' }, 'Two'));
    const purchase = h.el('button', { type: 'button', id: 'purchase' }, 'Buy now');
    const form = h.el('form', { action: '/checkout' });
    field.addEventListener(operation === 'TYPE_TEXT' ? 'input' : 'change', () => {
      purchase.click();
      form.dispatchEvent({ type: 'submit', isTrusted: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
    });
    h.document.body.append(field, purchase, form); h.document.hit = field;
    const snapshot = await h.snapshot(); const row = snapshot.elements[0];
    const result = await h.rpc('fast_act', actionParams(h, snapshot, operation, row.ref,
      operation === 'TYPE_TEXT' ? { text: 'filter' } : { optionId: row.options[1].id }));
    assert.equal(result.blockedReason, undefined);
    assert.equal(h.actions.some((action) => action.type === 'click'), true);
    assert.equal(h.actions.some((action) => action.type === 'submit'), true);
  });
});


test('readable business labels and native options remain eligible', async () => {
  const h = createContentHarness();
  h.document.body.append(h.el('button', { type: 'button' }, '\u5220\u9664'), h.el('button', { type: 'button' }, '\ud83d\ude80'), h.el('button', { type: 'button' }, '\u56de\u590d'));
  const select = h.el('select', { name: 'color' });
  select.append(h.el('option', { value: 'ordinary' }, 'Blue'), h.el('option', { value: 'delete' }, 'Option two'), h.el('option', { value: 'three' }, '\u5220\u9664'));
  h.document.body.append(select); h.document.hit = select;
  const snapshot = await h.snapshot();
  assert.deepEqual(snapshot.elements[0].operations, ['CLICK']);
  assert(snapshot.elements[1].risk && snapshot.elements[1].operations.length === 0);
  assert.deepEqual(snapshot.elements[2].operations, ['CLICK']);
  const row = snapshot.elements.find((entry) => entry.tagName === 'SELECT');
  assert.deepEqual(row.options.map((option) => option.disabled), [false, false, false]);
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'SELECT', row.ref, { optionId: row.options[1].id }));
  assert.equal(result.blockedReason, undefined); assert.equal(h.actions.some((action) => action.type === 'change'), true);
});

test('status does not treat background DOM churn as authority; dispatch rechecks the selected target', async () => {
  const { h, button } = buttonFixture(); await h.snapshot();
  assert.equal((await h.rpc('fast_status', h.config)).stale, false);
  button.readOnly = true;
  const status = await h.rpc('fast_status', h.config);
  assert.equal(status.stale, false); assert.equal(status.navigated, false); assert.equal(h.actions.length, 0);
  assert.deepEqual(Object.keys(status).sort(), ['challenge', 'navigated', 'pageChanged', 'stale']);
});

test('newly visible unrelated controls do not invalidate a stable visible target', async () => {
  const { h } = buttonFixture(); const other = h.el('button', { type: 'button' }, 'More details'); other.hidden = true;
  h.document.body.append(other); const snapshot = await h.snapshot(); other.hidden = false;
  const result = await h.rpc('fast_act', actionParams(h, snapshot, 'CLICK', snapshot.elements[0].ref));
  assert.equal(result.blockedReason, undefined); assert.equal(h.actions.length, 1);
});
