import { sanitizeText, sanitizeUrl } from './redact.js';

const OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'];
const TARGET_OPERATIONS = new Set(['CLICK', 'TYPE_TEXT', 'SELECT']);
const REF = /^e[1-9]\d{0,5}$/;
const TARGET_ID = /^e[1-9]\d{0,5}(?::o(?:0|[1-9]\d{0,4}))?$/;
const DECISION_KEYS = new Set(['operation', 'targetId', 'snapshotId', 'confidence', 'operationConfidence', 'targetConfidence', 'probabilities']);
const CODES = {
  INVALID_DOMAINS: 'The domain allowlist must contain explicit hostnames.',
  INVALID_URL: 'A valid absolute HTTP or HTTPS URL is required.',
  UNSAFE_URL: 'This URL is not eligible for automatic browser actions.',
  DOMAIN_BLOCKED: 'The page or target is outside the permitted hostname scope.',
  INVALID_SNAPSHOT: 'A bounded structured snapshot with stable references is required.',
  PAGE_CHALLENGE: 'The page requires manual challenge handling.',
  INVALID_DECISION: 'The decision does not match the bounded action protocol.',
  STALE_SNAPSHOT: 'The decision belongs to a different snapshot.',
  OPERATION_BLOCKED: 'The operation is not currently permitted.',
  TARGET_BLOCKED: 'The selected target is not currently permitted.',
};

const SAFE_CLICK_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);

function fail(code) {
  const error = new Error(CODES[code] || CODES.TARGET_BLOCKED);
  error.name = 'FastAgentPolicyError';
  error.code = code;
  return error;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsedHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw fail('INVALID_URL');
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('UNSAFE_URL');
  if (!url.hostname) throw fail('INVALID_URL');
  if (url.hostname.endsWith('.') || url.hostname.startsWith('[')) throw fail('UNSAFE_URL');
  return url;
}

function normalizedHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (!normalized || normalized.includes('*') || normalized.endsWith('.')) throw fail('INVALID_DOMAINS');
  if (!normalized.startsWith('[') && !normalized.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw fail('INVALID_DOMAINS');
  return normalized;
}

function explicitHostname(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 253 || /[\s\u0000-\u001f\u007f\/\\?#@%*]/.test(value)) throw fail('INVALID_DOMAINS');
  if (value.includes(':') || value.includes('[') || value.includes(']') || value.endsWith('.')) throw fail('INVALID_DOMAINS');
  let url;
  try { url = new URL(`https://${value}/`); } catch { throw fail('INVALID_DOMAINS'); }
  if (url.username || url.password || url.port || url.pathname !== '/' || !url.hostname) throw fail('INVALID_DOMAINS');
  return normalizedHostname(url.hostname);
}

/** Hostname scope deliberately does not imply subdomains or sibling hosts. */
export function normalizeDomains(startUrl, additions = []) {
  if (!Array.isArray(additions) || additions.length > 32) throw fail('INVALID_DOMAINS');
  const start = parsedHttpUrl(startUrl);
  const result = [...new Set([normalizedHostname(start.hostname), ...additions.map(explicitHostname)])];
  if (result.length > 32) throw fail('INVALID_DOMAINS');
  return result;
}

/** Call before serializing page data for cloud inference and again before act. */
export function assertAllowedUrl(value, domains) {
  const url = parsedHttpUrl(value);
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 32) throw fail('INVALID_DOMAINS');
  const allowed = new Set(domains.map(explicitHostname));
  if (!allowed.has(normalizedHostname(url.hostname))) throw fail('DOMAIN_BLOCKED');
  for (const [key, value] of url.searchParams) {
    if (!/(?:url|redirect|return|next|continue|dest)/i.test(key)) continue;
    let nested;
    try { nested = parsedHttpUrl(new URL(value, url).href); } catch { throw fail('UNSAFE_URL'); }
    if (!allowed.has(normalizedHostname(nested.hostname))) throw fail('UNSAFE_URL');
  }
  return url;
}

function semanticText(value) {
  if (typeof value !== 'string') return '';
  let text = value.slice(0, 8192);
  // Decode bounded URL obfuscation; malformed or deeper encodings remain blocked.
  try {
    for (let depth = 0; depth < 3 && /%[0-9a-f]{2}/i.test(text); depth++) text = decodeURIComponent(text);
    if (/%[0-9a-f]{2}/i.test(text) || /%(?![0-9a-f]{2})/i.test(text)) return 'credential';
  } catch { return 'credential'; }
  return text.normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/[_/?.#=+%:&-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function unsupportedLabel(value) {
  const text = semanticText(value);
  return !/[\p{L}\p{N}]/u.test(text);
}

function elementRisk(element, snapshot, allowedDomains) {
  if (!REF.test(element.ref || '')) return 'INVALID_REFERENCE';
  if (element.visible !== true) return 'INVISIBLE_ELEMENT';
  if (element.disabled === true) return 'DISABLED_ELEMENT';
  const inputType = String(element.inputType || '').toLowerCase();
  if (['file', 'hidden', 'reset', 'image'].includes(inputType)) return 'UNSUPPORTED_FIELD';
  const name = typeof element.name === 'string' ? element.name.trim() : '';
  if (!name || name.length > 512) return 'AMBIGUOUS_TARGET';
  if (unsupportedLabel(name)) return 'UNSUPPORTED_LABEL';
  if (typeof element.href === 'string') {
    try {
      if (/[\\\u0000-\u001f\u007f]/.test(element.href) || element.href !== element.href.trim()) return 'UNSAFE_URL';
      const href = new URL(element.href, snapshot.url);
      assertAllowedUrl(href.href, allowedDomains);
    } catch { return 'UNSAFE_URL'; }
  }
  return null;
}

function supports(element, operation) {
  if (!Array.isArray(element.operations) || !element.operations.includes(operation)) return false;
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  const type = typeof element.inputType === 'string' ? element.inputType.toLowerCase() : '';
  const role = typeof element.role === 'string' ? element.role.toLowerCase() : '';
  if (operation === 'TYPE_TEXT') return element.readOnly !== true && (tag === 'TEXTAREA' && role === 'textbox' || tag === 'INPUT' && ['', 'text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(type) && ['textbox', 'searchbox', 'spinbutton'].includes(role) || ['DIV', 'SPAN'].includes(tag) && role === 'textbox');
  if (operation === 'SELECT') return element.readOnly !== true && tag === 'SELECT' && ['combobox', 'listbox'].includes(role);
  if (operation !== 'CLICK' || !SAFE_CLICK_ROLES.has(role)) return false;
  if (tag === 'A') return ['link', 'button', 'tab', 'menuitem', 'treeitem'].includes(role) && typeof element.href === 'string' && element.href.length > 0;
  if (tag === 'BUTTON') return ['', 'button', 'submit'].includes(type) && ['button', 'tab', 'menuitem', 'treeitem'].includes(role);
  if (tag === 'INPUT') return element.readOnly !== true && (['button', 'submit'].includes(type) && role === 'button' || type === 'checkbox' && ['checkbox', 'switch'].includes(role) || type === 'radio' && role === 'radio');
  if (tag === 'SUMMARY') return role === 'button';
  return ['DIV', 'SPAN', 'LI'].includes(tag) && role !== 'link';
}

function targetRecord(element) {
  const result = { ref: element.ref, role: element.role.toLowerCase(), name: sanitizeText(element.name, 160), tagName: element.tagName.toUpperCase() };
  if (typeof element.inputType === 'string' && element.inputType) result.inputType = element.inputType.toLowerCase();
  if (typeof element.href === 'string') result.href = sanitizeUrl(element.href);
  return result;
}

/** Build legal opaque choices from structured DOM records, never model claims. */
export function buildActionSpace(snapshot, { allowedDomains } = {}) {
  if (!record(snapshot) || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || snapshot.snapshotId.length > 128 || !Array.isArray(snapshot.elements) || snapshot.elements.length > 2000) throw fail('INVALID_SNAPSHOT');
  assertAllowedUrl(snapshot.url, allowedDomains);
  if (snapshot.challenge) throw fail('PAGE_CHALLENGE');
  const targets = { CLICK: {}, TYPE_TEXT: {}, SELECT: {} };
  const excluded = [];
  const counts = new Map();
  for (const element of snapshot.elements) if (record(element) && typeof element.ref === 'string') counts.set(element.ref, (counts.get(element.ref) || 0) + 1);
  for (const element of snapshot.elements.slice(0, 200)) {
    if (!record(element)) continue;
    const risk = counts.get(element.ref) > 1 ? 'AMBIGUOUS_TARGET' : elementRisk(element, snapshot, allowedDomains);
    if (risk) {
      if (REF.test(element.ref || '')) excluded.push({ ref: element.ref, reason: risk });
      continue;
    }
    let included = false;
    for (const operation of ['CLICK', 'TYPE_TEXT']) {
      if (supports(element, operation)) {
        targets[operation][element.ref] = targetRecord(element);
        included = true;
      }
    }
    if (supports(element, 'SELECT') && Array.isArray(element.options)) {
      const optionCounts = new Map();
      for (const option of element.options.slice(0, 1000)) if (record(option) && typeof option.id === 'string') optionCounts.set(option.id, (optionCounts.get(option.id) || 0) + 1);
      for (const option of element.options.slice(0, 100)) {
        if (!record(option) || option.disabled === true || option.selected === true || !Number.isInteger(option.index) || option.index < 0 || option.index > 99999 || option.id !== `${element.ref}:o${option.index}` || optionCounts.get(option.id) !== 1 || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 512 || unsupportedLabel(option.label)) continue;
        targets.SELECT[option.id] = { ...targetRecord(element), optionId: option.id, label: sanitizeText(option.label, 160) };
        included = true;
      }
    }
    if (!included) excluded.push({ ref: element.ref, reason: element.readOnly === true ? 'READ_ONLY_ELEMENT' : 'UNSUPPORTED_ELEMENT' });
  }
  const operations = OPERATIONS.filter((operation) => TARGET_OPERATIONS.has(operation) ? Object.keys(targets[operation]).length > 0 : operation === 'SCROLL_UP' ? snapshot.scroll?.up === true : operation === 'SCROLL_DOWN' ? snapshot.scroll?.down === true : true);
  return { operations, targets, excluded };
}

/** Rebuild against current local data immediately before an extension dispatch. */
export function guardDecision(decision, space, snapshot, allowedDomains) {
  if (!record(decision) || Object.keys(decision).some((key) => !DECISION_KEYS.has(key)) || !OPERATIONS.includes(decision.operation)) throw fail('INVALID_DECISION');
  for (const key of ['confidence', 'operationConfidence', 'targetConfidence']) {
    if (decision[key] !== undefined && (typeof decision[key] !== 'number' || !Number.isFinite(decision[key]) || decision[key] < 0 || decision[key] > 1)) throw fail('INVALID_DECISION');
  }
  if (decision.snapshotId !== undefined && decision.snapshotId !== snapshot?.snapshotId) throw fail('STALE_SNAPSHOT');
  const current = buildActionSpace(snapshot, { allowedDomains });
  if (!record(space) || !Array.isArray(space.operations) || !space.operations.includes(decision.operation) || !current.operations.includes(decision.operation)) throw fail('OPERATION_BLOCKED');
  if (!TARGET_OPERATIONS.has(decision.operation)) {
    if (decision.targetId !== undefined) throw fail('INVALID_DECISION');
    return null;
  }
  if (typeof decision.targetId !== 'string' || !TARGET_ID.test(decision.targetId)) throw fail('INVALID_DECISION');
  const prior = space.targets?.[decision.operation];
  const fresh = current.targets[decision.operation];
  if (!record(prior) || !Object.hasOwn(prior, decision.targetId) || !Object.hasOwn(fresh, decision.targetId)) throw fail('TARGET_BLOCKED');
  const target = fresh[decision.targetId];
  const oldTarget = prior[decision.targetId];
  if (!record(oldTarget) || ['ref', 'role', 'name', 'tagName', 'inputType', 'optionId', 'label', 'href'].some((key) => oldTarget[key] !== target[key])) throw fail('TARGET_BLOCKED');
  return target;
}
