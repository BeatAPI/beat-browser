import { runTask, validateTaskOptions } from './runner.js';

const assertionSchema = {
  type: 'array', maxItems: 20,
  description: 'Caller-defined local success assertions. All must pass; without assertions, DONE remains unverified.',
  items: {
    oneOf: [
      ...['urlContains', 'selectorExists', 'textContains'].map((key) => ({
        type: 'object', additionalProperties: false, properties: { [key]: { type: 'string', minLength: 1, maxLength: 1000 } }, required: [key],
      })),
      { type: 'object', additionalProperties: false, properties: { selector: { type: 'string', minLength: 1, maxLength: 500 }, value: { type: 'string', maxLength: 2000 } }, required: ['selector', 'value'] },
      { type: 'object', additionalProperties: false, properties: { selector: { type: 'string', minLength: 1, maxLength: 500 }, checked: { type: 'boolean' } }, required: ['selector', 'checked'] },
      { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['ready'] } }, required: ['state'] },
    ],
  },
};

const inputSchema = {
  type: 'array', maxItems: 40,
  description: 'Exact caller-provided values. Use one ref or a unique accessible name, with optional role for name matching. Caller policy determines which fields may be filled.',
  items: {
    oneOf: [
      { type: 'object', additionalProperties: false, properties: { ref: { type: 'string', pattern: '^e[1-9][0-9]{0,5}$' }, text: { type: 'string', maxLength: 2000 } }, required: ['ref', 'text'] },
      { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, role: { type: 'string', minLength: 1, maxLength: 40 }, text: { type: 'string', maxLength: 2000 } }, required: ['name', 'text'] },
    ],
  },
};

export const BROWSER_TASK_TOOL = {
  name: 'browser_task',
  description: 'Optional finite browser executor using BeatAPI JEV. Requires explicit cloudConsent:true for each task. '
    + 'Sends a bounded redacted goal, current page structure/visible text and recent action metadata to the configured BeatAPI endpoint. '
    + 'Allowed HTTP(S) domains only; stops on stale targets, low confidence, challenges or uncertain execution. '
    + 'Business-action authorization belongs to the caller; Fast JEV does not classify payments, deletion, login or profile changes as prohibited categories. '
    + 'Return status and deterministic verification decide whether the outer agent should continue or ask the user.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      cloudConsent: { type: 'boolean', enum: [true], description: 'Explicit consent to cloud processing for this task. Must be true even for a dry run.' },
      url: { type: 'string', minLength: 1, maxLength: 2048, description: 'Caller-selected starting HTTP(S) URL. The task opens and pins its own tab.' },
      goal: { type: 'string', minLength: 1, maxLength: 4000, description: 'Bounded task instruction from the caller, separate from untrusted page data.' },
      maxSteps: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      maxModelCalls: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, default: 120000 },
      allowedDomains: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Additional exact hostnames; no wildcards, ports, URLs or implicit subdomains. Start hostname is included automatically.' },
      assertions: assertionSchema,
      inputs: inputSchema,
      clickNames: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 }, description: 'Optional exact accessible names that narrow CLICK candidates without exposing selectors or coordinates.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate local task configuration with zero network/browser calls and no API key requirement.' },
      allowTextHelper: { type: 'boolean', default: false, description: 'Permit bounded text generation only with an explicitly configured BEAT_BROWSER_TEXT_MODEL. Caller-supplied input wins.' },
      askOnBlock: { type: 'boolean', default: false, description: 'Permit the existing human handoff panel when the executor cannot make technical progress.' },
    },
    required: ['cloudConsent', 'url', 'goal'],
  },
};

const TASK_FIELDS = new Set(Object.keys(BROWSER_TASK_TOOL.inputSchema.properties));

/** This text describes the explicit opt-in boundary; it is never sent as task/page data. */
export function cloudConsentNotice(allowTextHelper = false, env = process.env) {
  let destination = 'the configured BeatAPI endpoint';
  try {
    const url = new URL(env?.BEATAPI_BASE_URL || 'https://api.beatapi.io');
    if (!url.username && !url.password && ['http:', 'https:'].includes(url.protocol)) destination = url.origin;
  } catch { /* Invalid configuration is handled by the runner, without exposing it. */ }
  return `[beat-browser fast-agent] Cloud consent: this task may send its bounded, redacted goal, page URL/title, visible text, interactive element labels/state, and recent action metadata to ${destination}. `
    + (allowTextHelper ? 'An explicitly configured text model may also receive bounded redacted task/page context for a field draft. ' : '')
    + 'Cookie/storage dumps, page authorization headers, raw HTML and screenshots are not part of the model payload. '
    + 'Redaction is best effort and does not guarantee removal of every secret or personal detail.';
}

function failure(status, reason, summary) {
  return { content: [{ type: 'text', text: JSON.stringify({ status, verified: false, blockedReason: reason, summary }) }], isError: true };
}

/** The optional tool is gated here as well as in the advertised tool list. */
export async function handleBrowserTask(args, {
  enabled = false,
  bridge,
  signal,
  env = process.env,
  stderr = process.stderr,
  runTaskImpl = runTask,
} = {}) {
  if (enabled !== true) return failure('disabled', 'FAST_AGENT_DISABLED', 'The server has not enabled browser_task. Manual browser tools remain available.');
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => !TASK_FIELDS.has(key))) {
    return failure('error', 'INVALID_TASK', 'Unsupported task arguments. Credentials, endpoints, models, arbitrary commands and output paths cannot be supplied per request.');
  }
  if (args.cloudConsent !== true) return failure('blocked', 'CLOUD_CONSENT_REQUIRED', 'This task requires explicit cloudConsent:true before any browser or model operation.');
  try {
    const { cloudConsent: _consent, ...task } = args;
    const options = validateTaskOptions({ ...task, enabled: true });
    if (!options.dryRun) stderr.write(cloudConsentNotice(options.allowTextHelper, env) + '\n');
    const result = await runTaskImpl({ ...options, signal }, { bridge, env });
    // Keep the MCP result small. In particular, never forward a snapshot or page body.
    const output = {};
    for (const key of ['status', 'verified', 'summary', 'tracePath', 'blockedReason', 'verification', 'metrics', 'tabId']) {
      if (result[key] !== undefined) output[key] = result[key];
    }
    if (result.status === 'dry_run') {
      for (const key of ['allowedDomains', 'maxSteps', 'maxModelCalls', 'timeoutMs', 'operations', 'capabilities', 'scope', 'limits']) {
        if (result[key] !== undefined) output[key] = result[key];
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      ...(['error', 'blocked', 'disabled', 'aborted', 'timeout'].includes(result.status) ? { isError: true } : {}),
    };
  } catch (error) {
    return failure('error', error?.code === 'INVALID_TASK' ? 'INVALID_TASK' : 'INTERNAL',
      error?.code === 'INVALID_TASK' ? 'Invalid local task configuration.' : 'The fast task stopped unexpectedly; no automatic retry was attempted.');
  }
}
