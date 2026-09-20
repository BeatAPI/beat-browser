# JEV Fast Agent

JEV Fast Agent is an optional, bounded browser executor inside BeatBrowser.
An outer agent supplies a concrete goal, allowed domain scope, exact inputs
and success assertions. The executor observes the current page, asks BeatAPI
JEV to choose from a finite action set, validates that choice, rechecks the
live target, performs one supported action and verifies the result.

It is off by default. The 23 ordinary manual MCP tools, local bridge,
installation flow and existing `ask` mechanism remain available without a
BeatAPI API key. Fast mode is intended for constrained interaction loops; the
outer agent retains planning, task authorization and handling of exceptions.

Before framing a task for a known site, the outer agent should read the same
BeatBrowser `learnings` used by Normal mode. Bundled and local learning files
are not automatically attached to a JEV request or uploaded wholesale. Apply
only relevant lessons through the bounded goal, exact inputs,
click names and assertions. When a live page contradicts a learning, trust the
page and update the note after the run.

## Prerequisites and configuration

Use the repository's supported Node.js version, install its existing
dependencies, and load the BeatBrowser Chrome extension. No new runtime
dependency is needed for fast mode. `beat-browser doctor --json` can diagnose
the manual bridge/extension connection, but it may start the bridge; it is not
an offline dry run.

For a source checkout, replace `beat-browser` in the examples with
`node src/cli.js`; the bare command assumes a global or linked installation.

Set credentials in the local process environment or a trusted secret manager.
Do not place keys in task goals, input files, MCP arguments, command flags or
committed configuration.

| Environment variable | Behavior |
| --- | --- |
| `BEATAPI_API_KEY` | Required only for an enabled live fast task. Read by Node and sent to the configured endpoint as a Bearer authorization header. |
| `BEATAPI_BASE_URL` | Defaults to `https://api.beatapi.io`. Accepts a service root or `/v1` suffix. HTTPS is required, except HTTP loopback endpoints for local tests. Configure only a trusted destination. |
| `BEAT_BROWSER_JEV_MODEL` | Defaults to `jev-1.13`. A trusted process-level model setting, never a task/page override. |
| `BEAT_BROWSER_TEXT_MODEL` | No default. Required when the explicitly allowed text helper is actually needed. Uses the same endpoint and API key. |
| `BEAT_BROWSER_FAST_AGENT` | Exactly `1` exposes `browser_task` at MCP server startup. Does not authorize an individual task; `cloudConsent: true` is still required. |

JEV requests use `POST /v1/systemone`; `/v1/decisions` is a documented alias.
Requests contain `model`, structured `state` and `questions`. This is a
synchronous typed-decision API, not chat completions or an asynchronous
generation task. Optional free text uses `POST /v1/chat/completions` with the
explicit text model. Neither path has a hidden retry loop.

The API contract was reviewed in the [BeatAPI Decisions documentation](https://docs.beatapi.io/decisions)
and [JEV product page](https://beatapi.io/jev-api) on 2026-09-20. A real paid
provider request is not part of the offline implementation tests. A separate
signed-in X control benchmark later used the live BeatAPI endpoint; see
`TEST_RESULTS.md` for its narrow scope and results.

## Validate a task without network or Chrome

```bash
beat-browser run --dry-run \
  --url https://example.com \
  --goal 'Check that the Example Domain page is ready' \
  --max-steps 10 --max-model-calls 20 --timeout-ms 60000
```

A dry run validates local task arguments and optional JSON files. It requires
no API key, creates no browser connection, makes no network request and does
not create a trace. Its JSON result has `status: "dry_run"`, `verified: false`,
normalized `allowedDomains`, selected budgets and supported `operations`.
It does not establish that Chrome is installed, a target page is reachable,
the provider configuration is valid or the task can complete.

## Run one bounded task

Create `assertions.json` containing a local success condition:

```json
[
  { "textContains": "Example Domain" }
]
```

With `BEATAPI_API_KEY` configured and Chrome connected:

```bash
beat-browser run --enable-fast-agent \
  --url https://example.com \
  --goal 'Check that the Example Domain heading is visible' \
  --assertions assertions.json \
  --max-steps 10 --max-model-calls 20 --timeout-ms 60000
```

The CLI sends the cloud processing notice to stderr and a single JSON result
to stdout. An already-satisfied assertion may complete after local observation
without a model request. An API key is still required for an enabled live run.
The returned `tabId` identifies this task's dedicated tab; preserve it if the
outer agent continues with ordinary tools.

| CLI flag | Default / accepted range |
| --- | --- |
| `--enable-fast-agent` | Required for a live CLI task; explicit consent to the documented cloud processing. |
| `--url URL` | Required HTTP(S) URL, at most 2,048 characters, with no embedded credentials. |
| `--goal TEXT` | Required caller goal, at most 4,000 characters. |
| `--max-steps N` | 20; integer from 1 to 100. |
| `--max-model-calls N` | 40; integer from 1 to 200, including JEV and text-helper calls. |
| `--timeout-ms N` | 120,000; integer from 1 to 600,000, covering the task deadline. |
| `--allow-domain HOST` | Repeatable; adds an exact hostname within the domain limits below. |
| `--allowlist FILE` | JSON array of additional hostnames, combined with `--allow-domain`; at most 32 supplied entries and 32 distinct hostnames including the start. |
| `--assertions FILE` | JSON array of up to 20 local assertions; all must pass. |
| `--inputs FILE` | JSON array of up to 40 exact caller-authorized field values. |
| `--click-name NAME` | Repeatable; restricts CLICK candidates to controls whose accessible name exactly matches one of up to 20 supplied names. |
| `--trace PATH` | A new local trace file; default is `~/.beat-browser/traces/<uuid>.jsonl`. Existing files are never overwritten. |
| `--dry-run` | Local validation only; does not require `--enable-fast-agent`. |
| `--allow-text-helper` | Off; allows bounded text generation only with an explicitly configured text model. |
| `--ask-on-block` | Off; permits the existing human handoff panel when blocked. The task still stops. |

JSON files must be regular files of at most 64 KiB each. Symlinks, non-array
JSON, malformed JSON, unknown flags, duplicate single-use flags, missing values
and out-of-range budgets fail before browser or model work. The CLI supports
separate flag/value tokens; it does not accept `--flag=value` syntax.

## Exact field inputs and optional text helper

Prefer an accessible name and optional role for stable task input:

```json
[
  { "name": "Search", "role": "textbox", "text": "public product documentation" }
]
```

A current initial-snapshot ref can also be supplied as
`{"ref":"e3","text":"public product documentation"}`. A ref is task-local;
do not reuse a ref from another tab, another task or an older observation.
Supplied refs are usable only on the first observed snapshot. After another
observation, use unique name bindings; a stale supplied ref stops instead of
applying a value to a newly assigned node. An accessible-name match must be
unique, or the task stops with an ambiguous-input reason. Each value is at
most 2,000 characters. An empty string
can clear a supported field. Input text is never interpreted as JavaScript,
a CSS selector, a URL to navigate to or a shell command.

Exact supplied input wins over generated text. If JEV selects a field with no
supplied value, the default response is to stop with `TEXT_REQUIRED`. Enabling
`--allow-text-helper` permits a bounded draft only when
`BEAT_BROWSER_TEXT_MODEL` is explicitly set. The helper must return a strict
JSON object containing only a `text` string, limited to 1,000 characters by the
default client configuration. It drafts generic text without inventing user
facts. It cannot create identity, credential or payment information, and its
call consumes the same model-call
budget. The caller decides which fields and values are authorized.

Typing does not press Enter or submit a form. An eligible visible submit button
is exposed through the same guarded CLICK operation as other buttons. Use
repeatable `--click-name` values when a dynamic page presents several controls
with similar labels; this narrows candidate identity but does not bypass live
target checks or verification.

## Local success assertions

Assertions are supplied by the caller and checked locally against current DOM
or URL state. They are not interpreted as model instructions. Supported shapes
are:

| Assertion | Meaning |
| --- | --- |
| `{"urlContains":"/results"}` | Current URL contains the supplied string. |
| `{"selectorExists":"[data-testid=results]"}` | The first matching light-DOM element is visible in the current viewport. |
| `{"textContains":"Results ready"}` | The supplied string appears in the first 20,000 characters of filtered visible light-DOM text. |
| `{"selector":"#query","value":"example"}` | The first matching non-private element is visible and has the exact supplied value. An empty expected value is supported. |
| `{"selector":"#include-archived","checked":false}` | The first matching element is visible and has the supplied native or ARIA checked state. |
| `{"state":"ready"}` | `document.readyState` is `complete`. This is only a document-readiness assertion. |

Element assertions do not search iframes or shadow roots, and off-screen
elements do not satisfy visibility checks. The visible-text scan excludes
editable/select content and recognized private contexts; it is not a full
document search. Private field values are not verified. Use a specific
selector when multiple elements could match, since these assertions inspect
the first match.

Choose assertions that prove the requested outcome. Readiness or a generic
heading cannot establish that an unrelated business task succeeded.
`completed` means all supplied assertions passed; it does not independently
prove that the caller selected adequate assertions. An unmet assertion never
becomes verified success. If the model selects `DONE` with no assertions, the
result is `completion_candidate` and `verified` remains `false`.

## Optional MCP delegation

Enable the tool at server startup using one of these alternatives:

```bash
BEAT_BROWSER_FAST_AGENT=1 beat-browser mcp
```

```bash
beat-browser mcp --enable-fast-agent
```

The advertised tool list adds only `browser_task`. The original 23 tools keep
their original schemas. Without startup opt-in, a direct unadvertised call to
`browser_task` is also rejected before connecting the bridge.

Example task arguments:

```json
{
  "cloudConsent": true,
  "url": "https://example.com",
  "goal": "Check that the Example Domain heading is visible",
  "maxSteps": 10,
  "maxModelCalls": 20,
  "timeoutMs": 60000,
  "allowedDomains": [],
  "assertions": [{ "textContains": "Example Domain" }],
  "inputs": [],
  "dryRun": true,
  "allowTextHelper": false,
  "askOnBlock": false
}
```

Set `dryRun` to `false` to request live execution with the configured key.
Every task requires `cloudConsent: true`, including an MCP dry run. The task
schema permits no per-request API key, base URL, model, arbitrary command,
selector action, tab ID or output file path. Selectors in assertions are only
local read conditions. The MCP result contains concise status, verification,
metrics and task metadata rather than full page content. A host-provided
cancellation signal is forwarded to the same runner used by the CLI.

Each fast run and its abort command stay pinned to the same connected Chrome
extension and task tab. The bridge checks the owner of a response and does
not queue fast commands for replay after reconnection. If that Chrome
disconnects, the task stops instead of moving to another connected browser.

## Status and cancellation

| Status | Caller interpretation |
| --- | --- |
| `completed` | All caller assertions passed; check `verified: true` and the individual verification booleans. |
| `completion_candidate` | Model proposed completion with no independent assertions; `verified: false`. |
| `blocked` | Review `blockedReason`; the outer agent or user must handle the unsupported or technically unavailable step. |
| `disabled` | No live cloud opt-in; no browser/model action was scheduled. |
| `dry_run` | Local validation succeeded; no execution was attempted. |
| `aborted` | Caller cancellation stopped future work. A dispatched action cannot be rolled back. |
| `timeout` | Task deadline expired; no further action will be scheduled. |
| `error` | Local configuration, response validation, trace, browser or provider failure stopped the task. |

CLI exit code is 0 for `completed`, `completion_candidate` and `dry_run`;
other statuses exit with 1. A zero exit code alone therefore does not establish
verified completion: inspect the JSON `status` and `verified` fields. SIGINT
and SIGTERM abort the task. Browser/provider cancellation is best effort once
an operation has reached the other side; the runner never retries an uncertain
side effect.

Extension stop reasons are normalized into stable uppercase result codes.
For example, `stale-snapshot` becomes `STALE_SNAPSHOT` and
`domain-out-of-scope` becomes `DOMAIN_BLOCKED`. Raw provider response bodies
and exception messages are not returned as task errors.

Metrics include task latency, steps, total/JEV/text model calls, actions,
retries, stale decisions, safety escalations and browser protocol calls. Token
usage is included when reported; incomplete usage is marked and totals become
`null`. An unknown token count is not treated as zero cost. Local trace files
are created with restrictive permissions and an exclusive create operation.
Trace target names are categorical labels such as `[button target]`, not the
page's actual accessible names. Every provider request ID is replaced with a
truncated SHA-256 digest; the original ID is not retained. This deliberate
privacy choice prevents direct provider-support lookup from the trace alone.
See [Privacy](../PRIVACY.md) for trace contents and residual privacy limits.

## Action and execution boundaries

The action vocabulary is `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`,
`SCROLL_DOWN`, `WAIT`, `DONE` and `BLOCKED`. Candidates are built directly from
the live DOM/ref map, not parsed from a human-readable snapshot. JEV chooses
only IDs from the current legal sets. Multiple speculative target heads can
be returned, but only the head for the selected operation is consumed.

Every requested choice head is validated for type, legal IDs, finite
probabilities/confidence, the exact probability-key set, sum tolerance and a
maximal selected probability. The operation and chosen target must meet the
configured confidence threshold. A well-formed or high-confidence response
still has to pass deterministic protocol, scope and live target checks.

The first release supports visible, enabled controls in the top frame's light
DOM and current viewport, including native `select` elements. Off-screen
controls require a supported scroll and a fresh observation. Option choices
map to code-owned current option IDs; the model cannot supply a new value.
Iframes, shadow DOM, custom dropdowns requiring unsupported actions, arbitrary
navigation, evaluation, coordinates, file-input uploads, network operations
and shell commands are outside the fast action space. The task's initial URL is
caller configuration, not a model action.

Fast JEV does not classify payments, purchases, deletion, account changes,
login, credential fields or same-domain downloads as prohibited business
categories. The caller or outer agent supplies the authorization policy, just
as it does for Normal mode. Challenges still stop because this executor cannot
solve them reliably. The existing human `ask` flow may help when technical
progress is unavailable.

Readable multilingual labels are eligible regardless of business meaning.
Emoji-only or otherwise unreadable target labels remain unsupported because
they do not provide a stable accessible identity.

Scope is the exact starting hostname plus explicitly added hostnames, with
at most 32 distinct entries stored as canonical lowercase ASCII hostnames,
including punycode where applicable. IPv6 hosts and trailing-dot hostnames are
unsupported. Entries cannot contain ports, URLs, wildcards or implied
subdomains. Known link destinations are checked before dispatch; domain
drift, unsafe redirects and a tab opened by the pinned task stop further
automatic work. An unrelated user tab in the same Chrome window does not stop
the pinned run. This guard
is not a network firewall: the page may already have made a cross-domain
request before a drift is observed.

Selected-target drift executes zero actions and triggers only a bounded fresh
observe/decide attempt. A stale status detected before `DONE` or around a text
helper also discards the old decision and recomputes from a fresh observation.
Unrelated dynamic-page DOM churn does not invalidate an otherwise unchanged,
visible selected target. Low-confidence or malformed output does not act.
No-effect loops and repeated target actions stop. A browser timeout or an
uncertain action receipt never causes an automatic retry of a possible side
effect. These constraints intentionally limit which tasks the executor can
complete without help.

These guards inspect observable DOM state, labels and destinations. They
cannot prove that arbitrary page JavaScript or event handlers are benign.
An innocently labeled control can still cause an unexpected site-side effect;
the implementation does not provide a universal side-effect safety guarantee.

## Verification and performance claims

Run the project's offline regression suite with `npm test`. The interface
tests can also be run with `node --test test/fast-interface.test.js`. They use
local mocks and temporary JSON files; no real API key, paid provider request
or signed-in external site is required.

Additional local checks and artifacts are available through:

```bash
npm run check:syntax
npm run build:extension
npm run benchmark:offline -- --iterations 3
```

The syntax check parses shipped JavaScript. The extension build packages
`dist/beat-browser-<version>.zip` locally and does not upload or publish it; the
packaging script requires the system `zip` executable. The offline benchmark
is `scripts/benchmark-fast-agent.mjs`. It reports A: a scripted outer-agent
schedule, B: the fast runner, and C: hybrid escalation over simulated fixture
state. It does not render the HTML fixture or invoke a real outer LLM.

The inherited `npm run test:live` script points to `test/scenarios.test.js`,
which was already absent in the baseline. That live suite remains unavailable;
it has not been replaced with a mock test described as live acceptance.

Offline fixtures and mock model timing validate control flow and accounting.
They do not establish real JEV latency, cost or task success in signed-in
Chrome. A real comparison must use the same tasks and success assertions,
include the same setup and verification boundaries, and separately report
verified success, median/p95 latency, model calls, tokens, retries, stale
decisions, safety escalations, protocol calls and unverified/blocked rates.
The upstream single 7.1-second example is not a BeatBrowser result.

The benchmark can aggregate separately collected measurements with
`node scripts/benchmark-fast-agent.mjs --input-records FILE`. Imported records
must use its explicit `live-external` schema. Their provenance is supplied by
the collector and is not independently verified by the aggregator.

The [implementation plan](./JEV_FAST_AGENT_PLAN.md) records design constraints.
Delivery test results and handoff notes distinguish offline evidence from
the remaining opt-in live acceptance work. Attribution and the complete
upstream MIT notice are in [Third-party notices](../THIRD_PARTY_NOTICES.md).
