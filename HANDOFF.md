# Fast JEV handoff

## Current state

BeatBrowser now has two execution modes over the same Node.js MCP server,
loopback bridge, Chrome extension and signed-in browser profile:

- **Normal**: the existing 23 explicit MCP tools, with no BeatAPI key required.
- **Fast JEV**: an opt-in bounded executor using BeatAPI `jev-1.13` through
  `POST /v1/systemone`.

Repository baseline: `7f674cff63d28b18371da2db5a393c470e4bd72e`.
Working branch: `codex/review-jev-delivery`. No commit, push or PR has been
created from this checkout.

## Live acceptance

On 2026-09-20, the same signed-in X profile published three approved replies in
Normal mode and three in Fast JEV mode. All six permanent reply URLs were read
from the live page before workbench writeback.

| Mode | Verified | Total wall time | Mean wall time |
| --- | ---: | ---: | ---: |
| Normal | 3/3 | 170.444 s | 56.815 s |
| Fast JEV final successful attempts | 3/3 | 36.240 s | 12.080 s |

The final Fast path was 4.7x faster in this narrow test. It used 10 JEV calls,
68,391 input tokens and 2,385 output tokens. At the tested price of $0.042 per
million input tokens with unbilled output, cost was approximately $0.00287.

Including all pre-fix Fast attempts, executor time was 112.568 seconds across
27 JEV calls and 186,133 input tokens. This cold integration path cost about
$0.00782. These results cover one workflow on one browser profile and are not a
general reliability or performance claim.

## Live defects converted into regressions and learnings

- New task tabs open active and wait for SPA settling.
- Contenteditable fields support paste-style input.
- Readable multilingual labels are eligible; business meaning is governed by the caller, not keyword blocks.
- Ordinary post/reply/message submits use the normal guarded click path.
- `--click-name` / `clickNames` narrows ambiguous controls by exact accessible
  name without exposing selectors or coordinates to JEV.
- Target freshness checks focus on the chosen target rather than unrelated
  dynamic-page churn.
- Unrelated user tabs do not interrupt a pinned run; child tabs opened by the
  task do.
- Reactive pages get a short post-type/post-click settle before re-observation.
- An uncertain publish receipt is never automatically replayed; the caller must
  inspect the live page and recover a durable result first.
- The reusable X rules are bundled in `docs/learnings/x.com.md`.

## Architecture boundaries

The Fast operation set is `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`,
`SCROLL_DOWN`, `WAIT`, `DONE` and `BLOCKED`. JEV can choose only opaque IDs from
the current legal operation/target sets. It cannot supply CSS selectors,
coordinates, JavaScript, shell commands, arbitrary URLs, uploads or downloads.

Local code validates the complete typed response, confidence, domain scope,
target identity and current geometry before execution. Caller-supplied exact
inputs and local success assertions remain outside model control. Model `DONE`
without assertions is only `completion_candidate`, never verified completion.

Fast JEV adds no separate business-action denylist: payments, deletion, login,
profile changes, credential fields and same-domain downloads are caller-policy
decisions. Challenges and cross-domain drift still stop execution. Visible
top-frame light-DOM controls are supported; iframes, shadow DOM, canvas,
file-input uploads and arbitrary keyboard widgets remain outside this release.

## Privacy boundary

Normal mode remains local and needs no BeatAPI account. Fast JEV is disabled by
default and requires explicit opt-in. The Node process sends bounded redacted
goal/page/action state to the configured BeatAPI endpoint. Cookies, storage
dumps, authorization headers, raw HTML, screenshots, typed exact input and raw
provider bodies are excluded from model payloads and traces. Redaction is best
effort, not a proof that arbitrary visible prose contains no private data.

See `PRIVACY.md` and `docs/JEV_FAST_AGENT.md` for the complete contract.

## Validation

The current checkout passed:

```text
npm test                 212/212
npm run check:syntax     42 JavaScript files
npm run check:security   69 source files, no findings
npm run build:extension  dist/beat-browser-1.2.0.zip
git diff --check         clean
```

The inherited `npm run test:live` entry still points to the baseline-missing
`test/scenarios.test.js`; it is not presented as passing. Offline benchmark
trials validate control flow and accounting, not real provider performance.

## Files to review first

- `README.md` — public dual-mode positioning, evidence and comparison.
- `docs/JEV_FAST_AGENT.md` — complete operator guide.
- `docs/learnings/x.com.md` — reusable live-site lessons.
- `TEST_RESULTS.md` — detailed test and live benchmark evidence.
- `PRIVACY.md` — local/cloud data boundary.
- `THIRD_PARTY_NOTICES.md` — huashu-chrome and jev-ultrafast attribution.
- `docs/JEV_FAST_AGENT_PR.md` — current PR draft.

Before creating a PR, rerun all checks, inspect the full diff, regenerate any
external patch/source ZIP that will be delivered, and update the branch if
`origin/main` has advanced. Publishing still requires an explicit maintainer
decision; this handoff does not authorize push, PR creation, merge, npm publish
or deployment.
