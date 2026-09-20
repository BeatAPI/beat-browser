// A dependency-free DOM double for the content-script RPC safety tests.
// It models DOM identity, attributes, native properties and queued mutations;
// it does not claim browser layout, native navigation or event-trust coverage.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

function matchesSimple(node, raw) {
  const selector = raw.trim();
  if (selector === '*') return true;
  if (selector === ':disabled') return !!node.disabled || !!node.closest('fieldset[disabled]');
  if (selector.includes('>') || selector.includes(' ')) return false;
  const tag = selector.match(/^[A-Za-z][A-Za-z0-9-]*/)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const id = selector.match(/#([A-Za-z0-9_-]+)/)?.[1];
  if (id && node.id !== id) return false;
  const cls = selector.match(/\.([A-Za-z0-9_-]+)/)?.[1];
  if (cls && !node.className.split(/\s+/).includes(cls)) return false;
  for (const attr of selector.matchAll(/\[([^\]\s=~*^$]+)(?:([*^$]?=)["']?([^\]"']*)["']?)?\]/g)) {
    const value = node.getAttribute(attr[1]);
    if (value === null) return false;
    if (!attr[2]) continue;
    const expected = attr[3];
    if (attr[2] === '=' && value !== expected) return false;
    if (attr[2] === '*=' && !value.includes(expected)) return false;
    if (attr[2] === '$=' && !value.endsWith(expected)) return false;
    if (attr[2] === '^=' && !value.startsWith(expected)) return false;
  }
  return !!(tag || id || cls || selector.includes('['));
}

export function createContentHarness({ url = 'https://example.test/start?filter=popular#hidden', title = 'Fixture' } = {}) {
  const observers = [];
  const actions = [];
  let listener;
  let document;
  class FakeEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); this.isTrusted = false; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
    stopImmediatePropagation() { this.stopped = true; }
  }
  class Element {
    constructor(tag, attrs = {}, text = '') {
      this.tagName = tag.toUpperCase(); this._attrs = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
      this._text = text; this.children = []; this.parentElement = null; this._value = attrs.value || '';
      this.checked = false; this.disabled = false; this.readOnly = false; this.multiple = false;
      this.selected = false; this.hidden = false; this.inert = false; this.isContentEditable = false;
      this.dataset = {}; this.listeners = new Map(); this.scrollHeight = 1800;
      this.rect = { left: 10, right: 210, top: 20, bottom: 60, width: 200, height: 40 };
      this.style = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto' };
    }
    cloneNode(deep = false) { const clone = new Element(this.tagName, Object.fromEntries(this._attrs), this._text); if (deep) for (const child of this.children) { const copy = child.cloneNode(true); copy.parentElement = clone; clone.children.push(copy); } return clone; }
    get attributes() { return Array.from(this._attrs, ([name, value]) => ({ name, value })); }
    get id() { return this.getAttribute('id') || ''; }
    get name() { return this.getAttribute('name') || ''; }
    get className() { return this.getAttribute('class') || ''; }
    get title() { return this.getAttribute('title') || ''; }
    get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : this.tagName === 'INPUT' ? 'text' : this.tagName === 'SELECT' ? 'select-one' : ''); }
    set type(v) { this.setAttribute('type', v); }
    get value() { return this.tagName === 'SELECT' ? this.options[this.selectedIndex]?.value || '' : this._value; }
    set value(v) { this._value = String(v); }
    get text() { return this.innerText; }
    get innerText() { return [this._text, ...this.children.filter((x) => !x.hidden && x.style.display !== 'none').map((x) => x.innerText)].filter(Boolean).join(' '); }
    set innerText(value) { this._text = String(value); document.notify(); }
    get textContent() { return [this._text, ...this.children.map((x) => x.textContent)].filter(Boolean).join(' '); }
    set textContent(value) { this._text = String(value); this.children = []; document.notify(); }
    get options() { return this.querySelectorAll('option'); }
    get selectedIndex() { const index = this.options.findIndex((option) => option.selected); return index < 0 && this.options.length ? 0 : index; }
    set selectedIndex(index) { this.options.forEach((option, i) => { option.selected = i === index; }); }
    get form() { return this.closest('form'); }
    get isConnected() { return this === document?.documentElement || !!this.parentElement?.isConnected; }
    getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
    hasAttribute(name) { return this._attrs.has(name); }
    setAttribute(name, value) { this._attrs.set(name, String(value)); document.notify(); }
    removeAttribute(name) { this._attrs.delete(name); document.notify(); }
    matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part)); }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getElementsByTagName(tag) { return this.querySelectorAll(tag); }
    closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
    contains(el) { for (let node = el; node; node = node.parentElement) if (node === this) return true; return false; }
    getRootNode() { return this.isConnected ? document : this; }
    getBoundingClientRect() { return this.rect; }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } document.notify(); return this; }
    remove() { if (this.parentElement) { const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; document.notify(); } }
    addEventListener(type, fn) { const handlers = this.listeners.get(type) || []; handlers.push(fn); this.listeners.set(type, handlers); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((handler) => handler !== fn)); }
    dispatchEvent(event) {
      event.target ||= this;
      if (event.type === 'click' || event.type === 'submit') for (const handler of document.listeners.get(event.type) || []) { handler(event); if (event.stopped) return false; }
      actions.push({ type: event.type, id: this.id });
      for (const handler of this.listeners.get(event.type) || []) handler(event);
      return !event.defaultPrevented;
    }
    click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true })); }
    focus() { actions.push({ type: 'focus', id: this.id }); document.activeElement = this; }
    scrollIntoView() { actions.push({ type: 'scrollIntoView', id: this.id }); }
  }
  class Input extends Element { constructor(attrs, text) { super('input', attrs, text); } }
  Object.defineProperty(Input.prototype, 'value', { get() { return this._value; }, set(value) { this._value = String(value); } });
  class TextArea extends Element { constructor(attrs, text) { super('textarea', attrs, text); } }
  Object.defineProperty(TextArea.prototype, 'value', { get() { return this._value; }, set(value) { this._value = String(value); } });
  const location = { href: url };
  document = {
    title, readyState: 'complete', listeners: new Map(),
    notify() { for (const observer of observers) observer.records.push({ type: 'mutation' }); },
    querySelectorAll(selector) { return [...(this.documentElement.matches(selector) ? [this.documentElement] : []), ...this.documentElement.querySelectorAll(selector)]; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementsByTagName(tag) { return this.querySelectorAll(tag); },
    getElementById(id) { return id ? this.querySelectorAll('*').find((el) => el.id === id) || null : null; },
    elementFromPoint() { return this.hit || this.querySelectorAll('input,button,a,select,textarea')[0] || this.body; },
    createTreeWalker(root) { const nodes = [root, ...root.querySelectorAll('*')].filter((el) => el._text).map((el) => ({ parentElement: el, nodeValue: el._text })); let i = 0; return { nextNode: () => nodes[i++] || null }; },
    addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); },
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== handler)); },
  };
  document.documentElement = new Element('html'); document.body = new Element('body'); document.documentElement.append(document.body); document.activeElement = document.body;
  const window = {
    innerHeight: 800, innerWidth: 1200, scrollX: 0, scrollY: 0, location,
    addEventListener() {}, scrollBy({ top }) { this.scrollY += top; actions.push({ type: 'scroll', amount: top }); },
  };
  window.top = window;
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; }
    observe() { observers.push(this); }
    takeRecords() { return this.records.splice(0); }
    disconnect() { observers.splice(observers.indexOf(this), 1); }
  }
  const context = vm.createContext({
    window, document, location, history: { pushState() {}, replaceState() {} },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    getComputedStyle: (el) => el.style, CSS: { escape: (s) => s }, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver, HTMLInputElement: Input, HTMLTextAreaElement: TextArea,
    Event: FakeEvent, MouseEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent,
    innerWidth: 1200, innerHeight: 800, URL, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'extension/content.js' });
  function el(tag, attrs = {}, text = '') { return tag.toLowerCase() === 'input' ? new Input(attrs, text) : tag.toLowerCase() === 'textarea' ? new TextArea(attrs, text) : new Element(tag, attrs, text); }
  const config = { runId: 'fixture-run-0001', allowedDomains: ['example.test'], deadline: Date.now() + 30000 };
  async function rpc(command, params = {}) {
    return new Promise((resolve, reject) => {
      listener({ __hc: command, ...params }, {}, (response) => response?.error ? reject(Object.assign(new Error(response.error.message), response.error)) : resolve(JSON.parse(JSON.stringify(response.data))));
    });
  }
  async function snapshot(overrides = {}) { return rpc('fast_snapshot', { ...config, ...overrides }); }
  async function act(snapshot, operation, target, extra = {}) {
    if (target) document.hit = target;
    const row = snapshot.elements?.find((row) => row.name === (target?.getAttribute('aria-label') || target?._text || target?.getAttribute('placeholder') || target?.name));
    const ref = extra.ref || row?.ref;
    return rpc('fast_act', { ...config, snapshotId: snapshot.snapshotId, expectedUrl: snapshot.url, operation,
      ...(ref ? { ref } : {}), ...extra });
  }
  return { document, window, location, el, actions, config, rpc, snapshot, act };
}
