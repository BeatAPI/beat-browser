import { createHash } from 'node:crypto';

// This is a second boundary after the extension scrubber. Unknown properties
// are deliberately not copied, including values from otherwise ordinary fields.
const OPERATIONS = new Set(['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_UP', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']);
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'treeitem']);
const TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'DIV', 'SPAN', 'LI', 'SUMMARY']);
const INPUT_TYPES = new Set(['text', 'search', 'button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'email', 'tel', 'password', 'file', 'number', 'url', 'hidden']);
const REF = /^e[1-9]\d{0,5}$/;
const TARGET_ID = /^e[1-9]\d{0,5}(?::o(?:0|[1-9]\d{0,4}))?$/;
const SECRET_FIELD = /(?:password|passphrase|passwd|passcode|secret|credential|api[\s_-]*key|token|one[\s_-]*time|verification[\s_-]*code|security[\s_-]*code|\botp\b|\bpin\b|\bcvv\b|\bcvc\b|card|billing|payment|address|e[\s_-]*mail|phone|mobile|telephone|\bname\b|surname|username|birth|\bdob\b|\bbday\b|\bgender\b|\bsex\b|\bage\b|passport|social[\s_-]*security|\bssn\b)/i;
const STATUSES = new Set(['configured', 'observing', 'deciding', 'validating', 'guarding', 'executing', 'checking_effect', 'completed', 'completion_candidate', 'blocked', 'dry_run', 'aborted', 'timeout', 'disabled', 'error', 'ok', 'success', 'failed', 'stale', 'no_effect', 'verified', 'unverified', 'retry', 'started', 'stopped', 'model_response', 'verification', 'decision', 'dispatching', 'executed', 'observed']);
const REASONS = new Set([
  'DOMAIN_BLOCKED', 'UNSAFE_URL', 'INVALID_DOMAINS', 'INVALID_URL', 'INVALID_SNAPSHOT', 'PAGE_CHALLENGE', 'INVALID_DECISION', 'STALE_SNAPSHOT', 'OPERATION_BLOCKED', 'TARGET_BLOCKED',
  'SENSITIVE_ACTION', 'SENSITIVE_FIELD', 'SENSITIVE_FORM', 'PAYMENT_BLOCKED', 'CHALLENGE', 'CAPTCHA', 'DOMAIN_DRIFT', 'LOW_CONFIDENCE', 'MALFORMED_RESPONSE', 'INVALID_RESPONSE',
  'NO_EFFECT', 'REPEATED_ACTION', 'REPETITION', 'STEP_LIMIT', 'MODEL_CALL_LIMIT', 'BUDGET_EXHAUSTED', 'TIMEOUT', 'ABORTED', 'UNKNOWN_INPUT', 'MISSING_INPUT', 'MISSING_TEXT_MODEL', 'MISSING_API_KEY',
  'TEXT_GENERATION_DISABLED', 'TEXT_INPUT_REQUIRED', 'ASSERTION_FAILED', 'INVALID_ASSERTION', 'EXECUTION_ERROR', 'PROVIDER_ERROR', 'BRIDGE_ERROR', 'FAST_AGENT_DISABLED', 'CLOUD_OPT_IN_REQUIRED', 'REDIRECT_BLOCKED',
  'INVISIBLE_ELEMENT', 'DISABLED_ELEMENT', 'READ_ONLY_ELEMENT', 'AMBIGUOUS_TARGET', 'UNSAFE_LABEL', 'UNSUPPORTED_LABEL', 'UNSUPPORTED_ELEMENT', 'UNSUPPORTED_FRAME', 'DOWNLOAD_BLOCKED', 'UPLOAD_BLOCKED', 'REDACTED_REASON',
  'RISK_BLOCKED', 'CROSS_DOMAIN', 'NEW_TAB', 'INVALID_TEXT', 'TEXT_MODEL_REQUIRED', 'TEXT_REQUIRED', 'AMBIGUOUS_INPUT', 'STEP_BUDGET', 'MODEL_BUDGET', 'STALE_LIMIT', 'UNMET_ASSERTIONS', 'MODEL_BLOCKED', 'NOT_INTERACTABLE', 'NO_EXTENSION', 'FAST_AGENT_BUSY',
  'INVALID_TASK', 'INVALID_BASE_URL', 'INVALID_MODEL', 'INVALID_CONFIG', 'BEATAPI_HTTP_ERROR', 'BEATAPI_NETWORK_ERROR', 'BEATAPI_TIMEOUT', 'RESPONSE_TOO_LARGE', 'REQUEST_TOO_LARGE', 'TRACE_WRITE_FAILED', 'BROWSER_ERROR', 'BROWSER_TIMEOUT', 'INVALID_VERIFICATION', 'INTERNAL_ERROR', 'UNCERTAIN_ACTION', 'REF_NOT_FOUND',
  'INVALID_API_KEY', 'INVALID_CLIENT_CONFIG', 'INVALID_REQUEST', 'PROVIDER_HTTP_ERROR', 'PROVIDER_REDIRECT', 'NETWORK_ERROR', 'UNSAFE_TEXT_TARGET', 'REQUEST_CONTAINS_SECRET', 'INVALID_QUESTIONS', 'INVALID_ACTION_SPACE', 'INVALID_CONFIDENCE',
]);
const USAGE_KEYS = new Set(['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens']);

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedLength(value, fallback, maximum) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(0, value)) : fallback;
}

/** Keep only the origin and a categorical indication that a path exists. */
export function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return '[redacted-url]';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[redacted-url]';
    return `${url.origin}${url.pathname !== '/' && url.pathname !== '' ? '/[path]' : '/'}`;
  } catch {
    return '[redacted-url]';
  }
}

/** Pattern masking is bounded and intentionally conservative, not a PII oracle. */
export function sanitizeText(value, maxLen = 512) {
  if (typeof value !== 'string') return '';
  const limit = boundedLength(maxLen, 512, 20000);
  let text = value.slice(0, 120000).normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
  text = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[redacted-secret]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|passwd|pwd|secret|api[\s_-]*key|client[\s_-]*secret|access[\s_-]*token|refresh[\s_-]*token|session[\s_-]*id|token|otp|pin|cvv|cvc)\s*["']?\s*(?::|=|\bis\b)\s*[^\r\n]*/gi, '[redacted-secret]')
    .replace(/\b(?:full[\s_-]*name|first[\s_-]*name|last[\s_-]*name|given[\s_-]*name|surname|username|name|address|passport|social[\s_-]*security|ssn)\s*["']?\s*[:=]\s*[^\r\n]*/gi, '[redacted-personal]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted-secret]')
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{5,}\b|\b(?:gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{6,}\b/g, '[redacted-secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/g, '[redacted-secret]')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, (match) => sanitizeUrl(match.startsWith('www.') ? `https://${match}` : match))
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[\p{L}\p{N}](?:[\p{L}\p{N}.-]{0,251}[\p{L}\p{N}])?\.[\p{L}]{2,63}/gu, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (match) => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 7 ? '[redacted-number]' : match;
    })
    .replace(/\b[A-Za-z0-9_+/=-]{12,}\b/g, (match) => {
      const tokenLike = (/[A-Za-z]/.test(match) && /\d/.test(match)) || match.length >= 24 || /(?:secret|token|api[_-]?key|password)/i.test(match);
      return tokenLike ? '[redacted-token]' : match;
    });
  return text.slice(0, limit);
}

function isSensitiveElement(element) {
  return element.sensitive === true || Boolean(element.risk) || Boolean(element.formRisk) ||
    ['password', 'email', 'tel', 'file', 'hidden'].includes(String(element.inputType || '').toLowerCase()) ||
    SECRET_FIELD.test(typeof element.name === 'string' ? element.name : '');
}

/** Explicit cloud schema: no raw values, IDs, attributes, form data or tab data. */
export function sanitizeSnapshot(snapshot) {
  if (!record(snapshot)) return { url: '[redacted-url]', title: '', visibleText: '', elements: [], scroll: { up: false, down: false }, challenge: false };
  const clean = {
    url: sanitizeUrl(snapshot.url),
    title: sanitizeText(snapshot.title, 200),
    visibleText: sanitizeText(snapshot.visibleText, 6000),
    elements: [],
    scroll: { up: snapshot.scroll?.up === true, down: snapshot.scroll?.down === true },
    challenge: Boolean(snapshot.challenge),
  };
  if (typeof snapshot.snapshotId === 'string' && /^s\d{1,12}$/.test(snapshot.snapshotId)) clean.snapshotId = snapshot.snapshotId;
  for (const element of (Array.isArray(snapshot.elements) ? snapshot.elements.slice(0, 200) : [])) {
    if (!record(element) || !REF.test(element.ref || '') || element.visible !== true || isSensitiveElement(element)) continue;
    const role = typeof element.role === 'string' ? element.role.toLowerCase() : '';
    const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
    const inputType = typeof element.inputType === 'string' ? element.inputType.toLowerCase() : '';
    const row = { ref: element.ref, role: ROLES.has(role) ? role : 'element', name: sanitizeText(element.name, 160), visible: true, disabled: element.disabled === true, readOnly: element.readOnly === true };
    if (typeof element.valuePresent === 'boolean') row.valuePresent = element.valuePresent;
    else if (typeof element.value === 'string') row.valuePresent = element.value.length > 0;
    if (TAGS.has(tagName)) row.tagName = tagName;
    if (INPUT_TYPES.has(inputType)) row.inputType = inputType;
    for (const key of ['checked', 'selected', 'expanded']) if (typeof element[key] === 'boolean') row[key] = element[key];
    if (typeof element.href === 'string') row.href = sanitizeUrl(element.href);
    if (Array.isArray(element.operations)) row.operations = [...new Set(element.operations.filter((operation) => OPERATIONS.has(operation)))].slice(0, 8);
    if (tagName === 'SELECT' && Array.isArray(element.options)) {
      row.options = element.options.slice(0, 100).filter((option) => record(option) && typeof option.id === 'string' && TARGET_ID.test(option.id) && option.id.startsWith(`${element.ref}:o`)).map((option) => ({ id: option.id, label: sanitizeText(option.label, 160), disabled: option.disabled === true, selected: option.selected === true }));
    }
    clean.elements.push(row);
  }
  return clean;
}

function probabilityMap(value, operationHead) {
  if (!record(value)) return {};
  const result = {};
  for (const [key, probability] of Object.entries(value).slice(0, 256)) {
    if (!(operationHead ? OPERATIONS.has(key) : TARGET_ID.test(key))) continue;
    if (typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1) result[key] = probability;
  }
  return result;
}

function safeCount(value, maximum = 1000000000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Never spread an entry or provider metadata into a persisted trace. */
export function sanitizeTraceEntry(entry) {
  if (!record(entry)) return {};
  const clean = {};
  if (typeof entry.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(entry.time)) {
    const epoch = Date.parse(entry.time);
    if (Number.isFinite(epoch) && epoch >= 0 && epoch <= 4102444800000) clean.time = new Date(epoch).toISOString();
  } else if (safeCount(entry.time, 4102444800000)) clean.time = entry.time;
  if (safeCount(entry.step, 10000)) clean.step = entry.step;
  if (OPERATIONS.has(entry.operation)) clean.operation = entry.operation;
  if (typeof entry.ref === 'string' && REF.test(entry.ref)) clean.ref = entry.ref;
  if (typeof entry.targetId === 'string' && TARGET_ID.test(entry.targetId)) clean.targetId = entry.targetId;
  if (ROLES.has(entry.targetRole)) clean.targetRole = entry.targetRole;
  if (typeof entry.targetName === 'string') clean.targetName = `[${clean.targetRole || 'element'} target]`;
  for (const key of ['confidence', 'operationConfidence', 'targetConfidence']) {
    if (typeof entry[key] === 'number' && Number.isFinite(entry[key]) && entry[key] >= 0 && entry[key] <= 1) clean[key] = entry[key];
  }
  if (record(entry.probabilities)) {
    clean.probabilities = {};
    if (record(entry.probabilities.operation)) clean.probabilities.operation = probabilityMap(entry.probabilities.operation, true);
    if (record(entry.probabilities.target)) clean.probabilities.target = probabilityMap(entry.probabilities.target, false);
  }
  if (typeof entry.requestId === 'string' && entry.requestId.length) clean.requestId = `sha256:${createHash('sha256').update(entry.requestId.slice(0, 4096)).digest('hex').slice(0, 24)}`;
  if (record(entry.usage)) {
    clean.usage = {};
    for (const key of USAGE_KEYS) if (safeCount(entry.usage[key])) clean.usage[key] = entry.usage[key];
  }
  for (const key of ['changed', 'pageChanged', 'stale', 'final']) if (typeof entry[key] === 'boolean') clean[key] = entry[key];
  if (typeof entry.retry === 'boolean' || safeCount(entry.retry, 1000)) clean.retry = entry.retry;
  if (STATUSES.has(entry.status)) clean.status = entry.status;
  if (typeof entry.blockedReason === 'string') clean.blockedReason = REASONS.has(entry.blockedReason) ? entry.blockedReason : 'REDACTED_REASON';
  if (typeof entry.verification === 'boolean') clean.verification = entry.verification;
  else if (record(entry.verification)) {
    clean.verification = {};
    for (const key of ['verified', 'provided', 'checked', 'passed', 'failed', 'matched', 'total']) {
      if (typeof entry.verification[key] === 'boolean' || safeCount(entry.verification[key], 10000)) clean.verification[key] = entry.verification[key];
    }
    if (Array.isArray(entry.verification.checks)) {
      clean.verification.checks = entry.verification.checks.slice(0, 100).filter((check) => record(check) && safeCount(check.index, 10000) && typeof check.passed === 'boolean').map((check) => ({ index: check.index, passed: check.passed }));
    }
  }
  return clean;
}
