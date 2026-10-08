# Test results

This file records what has actually been executed against BeatBrowser. It is
evidence for specific claims in the README, not a certification. Numbers from
live runs are small samples and are labelled as such.

## Automated checks

Run from a clean checkout with Node.js 20+ after `npm ci`:

| Command | Result |
| --- | --- |
| `npm test` | 215 passed, 0 failed, 0 skipped |
| `npm run check:syntax` | 44 JavaScript files pass `node --check` |
| `npm run check:security` | No findings (narrow source-pattern and extension cloud-boundary scan; not exhaustive secret detection) |
| `node src/cli.js run --dry-run --url https://example.com --goal 'Check page readiness'` | Exit 0; `status: "dry_run"`, zero model calls, no browser connection |

### Release preparation on 2026-10-08

- 215 automated tests passed; syntax and narrow source checks passed.
- The lockfile was refreshed within compatible dependency ranges, and the MCP
  SDK minimum was raised to 1.32.1. npm audit reported zero known vulnerabilities
  after the update (a point-in-time registry check, not a security guarantee).
- A tarball was installed in an isolated temporary prefix. Its CLI, extension
  files, fake-home installer and discovery of 23 Normal MCP tools passed.
- The existing Chrome extension (v1.2.0) was connected with no version mismatch.
  A logged-in GitHub page was observed read-only; no account settings were changed.
- A real-browser run against the explicitly labelled local demo fixture filled
  title/summary/team, read back its preview and persisted the draft across reload.
  A batch attempt at Publish note stopped at the sensitive-action guard.
- A separate MCP client read the same fixture tab to check explicit-tab handoff.
- Claude Code CLI authentication was unavailable during this check. A Claude-to-
  Codex recording has not been executed; docs/DEMO.md is the rehearsal script.
- The first pre-change suite run had one failure; an immediate repeat passed.
  The failing test was not retained in the truncated first output, so its cause
  is not established. The release checks above are new runs, not a claim that
  the earlier transient failure was diagnosed.

### What the suite covers

| Test file(s) | Main coverage |
| --- | --- |
| `test/bridge-boundary.test.js` | Malformed message isolation, multibyte-token rejection and Normal response ownership over loopback sockets. |
| `test/english-only.test.js` | Shipped files are English-only; no blanked user-facing messages; bundled learnings load and their `act` playbooks lint clean. |
| `test/fast-client.test.js` | Typed JEV request contract, malformed/unknown answers, confidence thresholds, bounded streams, abort/timeout, provider errors, optional text helper. |
| `test/fast-policy.test.js` | Action compatibility, exact hostname scope, supported labels/fields, select options, stale refs, cloud/trace redaction. |
| `test/fast-runner.test.js` | Disabled/default/key boundaries, budgets, cancellation, target narrowing and scrolling, stale recovery, no-effect/uncertain actions, verification, sanitized traces. |
| `test/fast-interface.test.js` | CLI flags and bounded input files, consent, dry run, optional MCP advertisement and dispatch, MCP stdio startup, unchanged schemas of the 23 Normal-mode tools. |
| `test/fast-transport.test.js` | Real loopback WebSocket transport with fake Chrome peers: owner pinning, cancellation routing, forged-receipt rejection, no queue/replay. |
| `test/fast-extension.test.js`, `test/fast-extension-background.test.js` | Structured DOM snapshots, node/ref ownership, live identity checks, pre-dispatch races, native submit behaviour, deadline/domain/new-tab checks. |
| `test/fast-benchmark.test.js` | Reproducible offline fixture outcomes with network disabled; external-record validation. |

Extension tests use DOM and Chrome API doubles; transport tests use real
loopback sockets with fake extensions. Neither substitutes for a live Chrome.
The Normal-mode tool schemas are checked for exact continuity; that does not
prove every interaction on every real site.

## Offline benchmark (mocked)

`npm run benchmark:offline -- --iterations 5` runs nine fixture tasks five times
per mode. All 135 trials are `offline-mock`: the HTML fixture is not rendered
and no real model is called. Raw output: `docs/JEV_BENCHMARK_RESULTS.json`.

| Metric | A: scripted outer agent | B: fast runner + mocks | C: scripted hybrid |
| --- | ---: | ---: | ---: |
| Trials | 45 | 45 | 45 |
| Fixture objective attained | 30 | 25 | 30 |
| Verified completed | 25 | 20 | 25 |
| Blocked | 15 | 20 | 15 |
| Expected outcomes matched | 45 | 45 | 45 |
| Simulated model calls | 75 | 50 | 80 |

The fixtures deliberately include rejection and unverified-completion cases.
Expected-outcome matching is a control-flow check, not a task-success rate, and
local millisecond timings say nothing about model speed or cost.

## Live browser smoke test: Normal vs Fast JEV (n=3)

One signed-in X account in a real Chrome profile published three approved
replies with Normal BeatBrowser tools and three with Fast JEV. Every reply was
confirmed by reading its permanent status URL from the page.

| Mode | Verified | Total wall time | Mean per reply |
| --- | ---: | ---: | ---: |
| Normal | 3/3 | 170.4 s | 56.8 s |
| Fast JEV (final attempts) | 3/3 | 36.2 s | 12.1 s |

- The three final Fast JEV runs used 10 JEV calls, 68,391 input tokens and
  2,385 output tokens.
- Counting every earlier Fast JEV attempt made while fixing integration bugs
  (dynamic-page settling, multilingual labels, off-screen composers, ambiguous
  reply controls, post-submit verification races), executor time was 112.6 s,
  or 37.5 s per published reply, with 27 JEV calls.
- One final Fast JEV run published successfully but first reported a
  verification false negative; the reply was then confirmed manually.

This is an early, single-site, small-sample smoke test. It is not a general
speed, success-rate, cost or safety claim.

## Not yet tested

- A cross-platform / Node-version matrix.
- Chrome Web Store installation (the extension is loaded unpacked).
- Real, repeated A/B latency, cost or success-rate measurements beyond the
  smoke test above.
- The optional Fast JEV text helper against a live text model.
