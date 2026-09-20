# JEV Fast Agent test results

These are recorded local execution results from 2026-09-20 UTC, not a test plan
or production certification. Base: `7f674cff63d28b18371da2db5a393c470e4bd72e`.
Branch: `codex/review-jev-delivery`. No implementation commit was created.
Environment: Linux, Node.js `v24.19.0`, npm `11.9.0`.

## Commands actually executed

Commands in this table ran in the implementation checkout unless specified.
Redirecting stdout/stderr to local validation logs did not change the commands'
test behavior. No real provider key or paid JEV/text request was used.

| Command | Observed result |
| --- | --- |
| `git ls-remote https://github.com/BeatAPI/beat-browser.git refs/heads/main` | Main was `7f674cff63d28b18371da2db5a393c470e4bd72e` at the start. |
| `npm ci --ignore-scripts` | Succeeded; installed 95 packages from the original lockfile. |
| Initial baseline `npm test` | 2 passed, 1 failed: missing `docs/learnings/x.com.md`. The original test was preserved; the missing seed was restored. |
| `npm test` after implementation | Latest run: 212 passed, 0 failed, 0 cancelled, 0 skipped. |
| `npm run check:syntax` | Passed: 42 JavaScript files checked with `node --check`. |
| `npm run check:security` | Passed: 69 files scanned, no findings from the narrow source-pattern and extension cloud-boundary scanner. |
| `npm run build:extension` | Passed; local `dist/beat-browser-1.2.0.zip`, approximately 112 KB. The existing packaging script removed `manifest.key` from this extension build. Nothing was uploaded or published. |
| `npm pack --dry-run` | Passed. Final inspection: 55 entries, 214.4 KB package size, 733.5 KB unpacked. All fast-agent modules, cover art and required license/privacy/notices were included. No package publication occurred. |
| Initial `npm audit --omit=dev --json` | Found two moderate transitive vulnerabilities: `hono` and `qs`. |
| `npm update hono qs --ignore-scripts --no-audit --no-fund` | Succeeded; `hono` 4.13.4 -> 4.13.8 and `qs` 6.15.3 -> 6.16.0. No new direct dependency. |
| Final `npm audit --omit=dev --json` | Zero info, low, moderate, high or critical vulnerabilities reported for the resolved production dependencies. This is registry advisory evidence as of the run, not a general security proof. |
| `node scripts/benchmark-fast-agent.mjs --iterations 5` | 135 offline-mock trials; 135 expected outcomes matched. Raw result is `docs/JEV_BENCHMARK_RESULTS.json`. |
| `node src/cli.js run --dry-run --url https://example.com --goal 'Check page readiness' --max-steps 10 --max-model-calls 20 --timeout-ms 60000` | Exit 0; JSON `status: "dry_run"`, `verified: false`, zero model calls and no trace. |
| `git diff --check` | Passed after implementation and documentation changes. |

The environment emits an npm warning about its `http-proxy` configuration.
The recorded commands still exited successfully. This warning is not a
repository failure and no environment secrets were printed.

## Fresh-baseline reproduction actually executed

A fresh local clone was created from the baseline commit without remote writes:

```bash
git clone --no-hardlinks /workspace/scratch/daf05bca7b1f/beat-browser /workspace/scratch/daf05bca7b1f/verification/beat-browser
```

In that fresh checkout, the complete implementation diff was checked and applied:

```bash
git apply --check /workspace/scratch/daf05bca7b1f/validation/implementation.patch
git apply /workspace/scratch/daf05bca7b1f/validation/implementation.patch
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
```

All commands exited 0. A fresh install added 95 packages from cache. The suite
again passed **202/202**, with **0 failures and 0 skipped**, in approximately
2.61 seconds. This confirms the implementation did not depend on untracked
runtime files or the first checkout's installed dependencies. Delivery-document
and final archive checks are recorded below.

## Test suite inventory and meaningful coverage

| Test file(s) | Passed | Main coverage |
| --- | ---: | --- |
| `test/english-only.test.js` | 3 | All original repository assertions, including the restored learning seed. The test file is unchanged. |
| `test/fast-client.test.js` | 55 | Exact typed JEV request contract, all speculative heads, malformed/unknown answers, complete probability distributions, confidence thresholds, bounded streams, abort/timeout, provider errors, optional text JSON and caller-owned field policy. |
| `test/fast-policy.test.js` | 26 | Pure action compatibility, caller-owned business policy, exact hostname scope, supported labels/fields, select options, stale refs and cloud/trace redaction. |
| `test/fast-runner.test.js` | 31 | Disabled/default/key boundaries, budgets, cancellation, exact-target narrowing and scrolling, input bindings, stale recovery, no-effect/repeated/uncertain actions, verification and sanitized traces. |
| `test/fast-interface.test.js` | 34 | CLI flags and bounded files, consent, dry run, optional MCP advertisement and dispatch, actual MCP stdio with bridge/key/fetch traps, unchanged 23 manual tool schemas and empty-value assertions. |
| `test/fast-transport.test.js` | 6 | Real loopback WebSocket transport with fake Chrome peers: extension owner pinning, cancellation routing, forged receipt rejection, no queue/replay, extension reason normalization with runner integration, already-aborted promise cleanup. |
| `test/fast-extension.test.js`, `test/fast-extension-background.test.js` | 49 | Structured DOM snapshots, raw node/ref ownership, live mutation/property/form/option identity checks, asynchronous pre-dispatch races, native submit and page-owned event behavior, deadline/cancellation/domain/new-tab checks and fresh visible assertions. |
| `test/fast-benchmark.test.js` | 8 | Reproducible fixture outcomes and counters with network disabled, syntax/CLI execution, safe external-record validation, mixed-evidence rejection and unknown usage accounting. |
| **Total** | **212** | **0 failed, 0 skipped.** |

The manual MCP schema regression serializes the original tool definitions and
checks SHA-256
`00590d166e65b6926d05b94ac41cdb9d13a8371a6bfb159c92255fae63eff3d3`.
This checks exact tool-schema continuity and startup/dispatch behavior. It does
not prove every manual Chrome interaction in a real browser.

Extension tests use local DOM and Chrome API doubles; transport tests use real
loopback sockets with fake extensions. Neither substitutes for live Chrome.
Most model tests inject fetch or a typed-response client. No mock timing is
reported as provider latency.

## Independent review regressions resolved

The following concrete findings were reproduced during review and fixed before
the final suite passed:

- The original semantic denylist prevented caller-authorized payment, deletion,
  login, profile and credential workflows; Fast now inherits business policy
  from the caller and keeps only technical execution checks.
- A second connected Chrome could change the bridge primary and receive another
  run's abort; fast-run ownership is now pinned to the original socket.
- A receipt from a different Chrome socket could resolve a fast pending call;
  fast replies now require the pending call's owner socket.
- Extension lowercase failure reasons did not match runner codes; transport now
  maps them explicitly, including stale/domain/risk and uncertain outcomes.
- Exact input and click targets could be absent from the current viewport while
  JEV still received WAIT/DONE; the runner now narrows to matching targets and
  exposes only scrolling until a missing exact target becomes visible.
- Stale live status did not invalidate DONE/helper paths; current status now
  triggers bounded fresh observation/decision before either path is used.
- An already-aborted signal could leave a passed rejected promise unhandled;
  the abort helper now handles that rejection without starting another action.

## Source/security inspection scope

`scripts/check-security.mjs` checks selected credential-shaped literals,
private-key material, unexpected symlinks and the extension/cloud credential
boundary. It intentionally reports file/line/rule only, never matched secret
text. Tests use synthetic runtime-generated credential strings. This scanner
is not a comprehensive secret detector, penetration test or formal proof.

Additional tests cover raw passwords/tokens/private values being excluded from
cloud snapshots, exact configured-key rejection in payloads, sanitized trace
schemas, unknown provider bodies and no headers in thrown errors. Audit logging
of fast commands excludes URLs, input text, assertions and cloud credentials.

Heuristic redaction can miss personal data in arbitrary visible prose. Risk
labels and DOM event guards cannot prove arbitrary page scripts harmless.
Cross-domain stops do not form a browser network firewall. These boundaries
are explicitly documented in the guide and privacy notice.

## Recorded offline benchmark

Evidence mode is `offline-mock` for all 135 trials. Each mode ran nine fixture
tasks five times. A uses a scripted ordinary-agent schedule, B uses the real
fast runner with mocks, and C adds a scripted outer assessment/escalation.
The HTML fixture was not rendered and no real outer LLM ran.

| Metric | A: scripted outer | B: fast runner + mocks | C: scripted hybrid |
| --- | ---: | ---: | ---: |
| Trials | 45 | 45 | 45 |
| Fixture objective attained | 30 | 25 | 30 |
| Verified completed | 25 | 20 | 25 |
| Blocked | 15 | 20 | 15 |
| Unverified candidate | 5 | 5 | 5 |
| Expected outcomes matched | 45 | 45 | 45 |
| Simulated model calls | 75 | 50 | 80 |
| Protocol calls | 290 | 415 | 450 |
| Browser actions in simulated state | 35 | 30 | 35 |
| Fresh-decision retries | 5 | 5 | 5 |
| Stale decisions | 5 | 5 | 5 |
| Safety/escalation counter | 15 | 20 | 20 |
| Median local harness latency, ms | 0.033646 | 1.347303 | 1.308767 |
| p95 local harness latency, ms | 0.308265 | 5.425766 | 2.824632 |
| Input tokens | Unknown | Unknown | Unknown |

The safety/escalation counter includes blocked stages such as no-effect and
budget failures; it is not exclusively a high-impact-action counter. The hybrid
can record a blocked fast stage and later complete through its scripted outer
continuation. Missing usage remains `null`, not an invented zero-token claim.

These fixtures deliberately include rejection and unverified-completion cases.
Expected-outcome matching is a control-flow check, not a real task-success rate.
Local millisecond measurements do not compare model speed or cost. The upstream

## Checks intentionally not executed

- The original offline delivery did not execute real JEV inference or a signed-in
  browser workflow. The later narrow live X benchmark below covers those two
  paths only; text-model inference, extension-store installation and a
  cross-platform/Node-version matrix remain untested.
- The inherited `npm run test:live`: its target `test/scenarios.test.js` is
  absent in the baseline and remains absent; this is unavailable, not passed.
- Real A/B/C latency, token cost or comparative task-success measurements.
- Git push, PR creation, merge, npm publication or deployment.

## 2026-09-20 live X browser-control benchmark

The same signed-in `@Eric_Kangg` Chrome profile published three approved replies
through ordinary BeatBrowser control and three through JEV Fast mode. Durable X
reply URLs were independently read from the target-page DOM and written back to
the existing workbench. The BeatAPI key came from the local macOS Keychain and
was not written to a task file, trace or report.

| Mode | Verified replies | Total wall time | Mean wall time |
| --- | ---: | ---: | ---: |
| Normal BeatBrowser | 3/3 | 170.444 s | 56.815 s |
| Fast/JEV, final successful publication attempts | 3/3 | 36.240 s | 12.080 s |

On this small workload, the final Fast path was about 4.7x faster by wall time.
Including every pre-fix Fast attempt made during live integration, executor time
was 112.568 seconds, or 37.523 seconds per ultimately published reply (about
1.5x faster than the Normal total). That cold path required 27 JEV calls and
exposed real control defects: dynamic-page settling, multilingual labels,
off-screen composers, ambiguous reply controls, unrelated-tab interruption and
post-submit verification races. The final three publication attempts used 10
JEV calls, 68,391 reported input tokens and 2,385 reported output tokens.

One of the three final Fast attempts published successfully but initially
returned a verification false-negative; the durable reply was then confirmed
before writeback. The third run validated the added post-click settle and
completed with `verified:true`. These three posts are a browser-control smoke
benchmark, not a general success-rate, cost or safety claim.

Reply URLs:

- `https://x.com/Eric_Kangg/status/2101643184166281422`
- `https://x.com/Eric_Kangg/status/2101644826727026962`
- `https://x.com/Eric_Kangg/status/2101645743933304962`

After the live-control fixes, the current checkout passed 212/212 tests,
syntax checked 42 JavaScript files, scanned 69 source files with no reported
findings, passed `git diff --check`, and rebuilt the extension ZIP. The patch,
ZIP and copied reports described in the historical section below predate these
live fixes and must be regenerated before handoff or PR creation.

Reproduction commands, source provenance, all changed files, deviations and
The PR text was a local draft
in `docs/JEV_FAST_AGENT_PR.md`.

## Original delivery artifact verification before the live benchmark

After adding the delivery documents, the full suite passed again at 202/202,
syntax checked all 42 JavaScript files, the source scanner checked 69 files
with no findings, and npm dry-run inspection reported 54 entries. The exact
package sizes are in the command table above.

The full Git patch was generated from the index against the recorded baseline:

```bash
git add -A
git diff --cached --check
git diff --cached --binary 7f674cff63d28b18371da2db5a393c470e4bd72e > /workspace/scratch/daf05bca7b1f/deliverables/beat-browser-jev-fast-agent.patch
```

A second fresh local clone was made at
`/workspace/scratch/daf05bca7b1f/verification-final/beat-browser`. In that checkout,
these commands were executed:

```bash
git apply --check ../../deliverables/beat-browser-jev-fast-agent.patch
git apply --index ../../deliverables/beat-browser-jev-fast-agent.patch
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
git diff --cached --check
```

The patch applied successfully, the clean cached dependency installation
succeeded and all 202 tests passed. The patch covers 41 changed/added files.
No implementation commit or remote write was needed.

The full-source ZIP was built with Python's standard `zipfile` module from the
explicit `git ls-files` manifest, using the current bytes of every staged source
file. Verification used `ZipFile.testzip()`, exact entry-set checking and byte
comparisons. All **80 source files** matched across the implementation checkout,
the patched baseline checkout and the ZIP. The two separately delivered Markdown
reports matched their copies in the ZIP. A final documentation-only wording
correction and this results section were included when regenerating the artifacts;
the resulting patch was checked/applied again and the 202-test suite passed.

Archive path checks excluded `.git`, `node_modules`, `.env` and `.env.*`, generated
`dist`, runtime traces, browser profile directories and build caches. There were
no symlinks in the source manifest. The ZIP is the full source delivery; the
separately tested extension build can be reproduced with `npm run build:extension`.
No raw runtime trace, browser session data or provider credential was used as an
archive input.
