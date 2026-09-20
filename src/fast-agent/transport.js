import { BridgeClient } from '../lib/rpc.js';

const fail = (code) => Object.assign(new Error(code), { code });
const REASONS = Object.freeze({
  'stale-snapshot': 'STALE_SNAPSHOT', 'domain-out-of-scope': 'DOMAIN_BLOCKED',
  'cross-domain-link': 'DOMAIN_BLOCKED', 'aborted': 'ABORTED', 'deadline-exceeded': 'TIMEOUT',
  'challenge': 'PAGE_CHALLENGE', 'execution-unknown': 'UNCERTAIN_ACTION',
  'new-tab-opened': 'NEW_TAB', 'new-tab-link': 'NEW_TAB',
  'sensitive-page': 'RISK_BLOCKED', 'sensitive-action': 'RISK_BLOCKED', 'sensitive-link': 'RISK_BLOCKED',
  'unsupported-page': 'RISK_BLOCKED', 'unsupported-label': 'RISK_BLOCKED',
  'sensitive-field': 'RISK_BLOCKED', 'sensitive-form': 'RISK_BLOCKED', 'submit-control': 'RISK_BLOCKED',
  'unsupported-input': 'TARGET_BLOCKED', 'unsupported-editor': 'TARGET_BLOCKED',
  'unsupported-frame': 'TARGET_BLOCKED', 'ambiguous-action': 'TARGET_BLOCKED',
  'unsafe-form': 'RISK_BLOCKED', 'unsafe-link': 'RISK_BLOCKED', 'file-transfer': 'RISK_BLOCKED',
  'incompatible-target': 'TARGET_BLOCKED', 'invalid-option': 'TARGET_BLOCKED',
  'covered-target': 'NOT_INTERACTABLE', 'malformed-request': 'INVALID_REQUEST',
  'run-config-changed': 'INVALID_REQUEST', 'run-already-started': 'INVALID_REQUEST',
  'setup-timeout': 'TIMEOUT', 'setup-failed': 'BROWSER_ERROR',
  'content-unavailable': 'BROWSER_ERROR', 'tab-unavailable': 'BROWSER_ERROR',
  'unknown-run': 'BROWSER_ERROR', 'tab-required': 'BROWSER_ERROR',
});

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('BROWSER_ERROR');
  if (result.blockedReason) return { ...result, blockedReason: REASONS[result.blockedReason] || 'BROWSER_ERROR' };
  return result;
}

/** The only adapter from the Node bounded executor to the existing local bridge. */
export function createBridgeAdapter({ bridge } = {}) {
  const owned = !bridge;
  let client = bridge, current, abortListener, abortPromise;

  function check(context) {
    if (context.signal.aborted) throw fail('ABORTED');
    if (Date.now() >= context.deadline) throw fail('TIMEOUT');
  }

  async function connect(context) {
    check(context);
    if (!client) client = new BridgeClient({ client: 'fast-agent', sessionId: `fast:${context.runId}` });
    if (!client.ws) await client.connect({ timeoutMs: Math.min(10000, context.deadline - Date.now()), signal: context.signal });
    check(context);
    if (!client.extensionOnline) throw fail('NO_EXTENSION');
    if (current !== context) {
      if (current && abortListener) current.signal.removeEventListener('abort', abortListener);
      current = context;
      abortListener = () => { void abort(context); };
      context.signal.addEventListener('abort', abortListener, { once: true });
    }
  }

  async function call(command, params, context) {
    await connect(context);
    check(context);
    const result = await client.call(command, {
      ...params, runId: context.runId, allowedDomains: context.allowedDomains, deadline: context.deadline,
    }, { tabId: context.tabId, timeoutMs: Math.max(1, Math.min(35000, context.deadline - Date.now())), signal: context.signal });
    return normalizeResult(result);
  }

  async function abort(context) {
    if (abortPromise) return abortPromise;
    if (!client?.ws || !client.extensionOnline) return;
    abortPromise = client.call('fast_abort', { runId: context.runId }, { tabId: context.tabId, timeoutMs: 1500 }).catch(() => {});
    return abortPromise;
  }

  return {
    async open(url, context) {
      const result = await call('fast_open', { url }, context);
      if (Number.isSafeInteger(result?.tabId)) context.tabId = result.tabId;
      return result;
    },
    observe(context) { return call('fast_snapshot', {}, context); },
    status(context) { return call('fast_status', {}, context); },
    execute(action, context) { return call('fast_act', action, context); },
    verify(assertions, context) { return call('fast_verify', { assertions }, context); },
    async ask(reason, context) {
      check(context);
      // The user takes over. This response is never a ticket to resume auto execution.
      const result = await client.call('ask', {
        title: 'Fast Agent stopped',
        prompt: 'This bounded task needs manual review. Review the terminal or outer agent result before continuing.',
        timeout: Math.min(30000, Math.max(1000, context.deadline - Date.now())),
        wantNote: false, focus: false, disabled: process.env.BEAT_BROWSER_ASK === 'off',
      }, { tabId: context.tabId, timeoutMs: Math.min(35000, context.deadline - Date.now()), signal: context.signal });
      return { outcome: ['continued', 'completed', 'cancelled', 'timed_out', 'disabled'].includes(result?.outcome)
        ? result.outcome : 'unknown' };
    },
    abort,
    close() {
      if (current && abortListener) current.signal.removeEventListener('abort', abortListener);
      if (owned) client?.close();
    },
  };
}
