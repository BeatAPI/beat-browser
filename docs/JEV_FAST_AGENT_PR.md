## Summary

Adds **Fast JEV** as an optional second execution mode beside BeatBrowser's
existing **Normal** MCP tools.

- Normal remains the default: 23 explicit browser tools, local bridge, signed-in
  Chrome, no BeatAPI key required.
- Fast JEV adds an opt-in bounded executor through BeatAPI `jev-1.13`.
- Both modes use the same extension, bridge and browser profile; the outer
  agent can use the same local/bundled site learnings to frame either workflow.
- Exact inputs, exact accessible-name click narrowing and local assertions keep
  task intent outside the model's control.
- Business-action authorization comes from the caller/outer agent, matching
  Normal mode. Fast JEV retains technical guards for scope, stale targets,
  challenges, supported controls and uncertain execution.

## Live browser-control evidence

On 2026-09-20, the same signed-in X account published three approved replies
with each mode and verified all six through permanent status URLs.

| Mode | Verified | Total | Mean |
| --- | ---: | ---: | ---: |
| Normal | 3/3 | 170.444 s | 56.815 s |
| Fast JEV | 3/3 | 36.240 s | 12.080 s |

The final Fast path was 4.7x faster in this narrow `n=3` smoke test. It used 10
JEV calls, 68,391 input tokens and 2,385 output tokens. At the tested BeatAPI
price, the three Fast runs cost approximately $0.00287 total. This is not a
general benchmark; one successful publication initially produced a local
verification false negative before permanent-URL recovery confirmed it.

## What the live run changed

- Open task tabs active and wait for SPA settling.
- Support readable multilingual labels without business-keyword blocking.
- Support contenteditable paste for modern editors.
- Permit ordinary post/reply/message submits through the same guarded click
  path as other controls.
- Recheck selected-target identity without treating unrelated DOM churn as
  stale.
- Ignore unrelated user tabs while stopping on child tabs opened by the task.
- Add repeatable `--click-name` / `clickNames` candidate narrowing.
- When an exact target is off-screen, offer only the required scroll direction
  instead of letting JEV wait or finish early.
- Add short post-type and post-click settling before observation/verification.
- Persist the X-specific lessons in the bundled learning seed.

## Validation

- `npm test`: 212/212 passed
- `npm run check:syntax`: 42 JavaScript files passed
- `npm run check:security`: 69 files, no findings
- `npm run build:extension`: extension ZIP built
- `git diff --check`: passed

## Boundaries

Fast JEV supports visible top-frame light-DOM controls. Iframes, shadow DOM,
canvas, uploads and arbitrary keyboard widgets remain outside this first
release. Live evidence covers one X workflow on one browser profile. The
complete evidence, costs and limitations are in `TEST_RESULTS.md`; configuration
and consent boundaries are in `docs/JEV_FAST_AGENT.md` and `PRIVACY.md`.
