![BeatBrowser — Fast JEV browser control for your signed-in Chrome](media/cover.webp)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#two-modes-one-browser">Two modes</a> ·
  <a href="#real-browser-control-smoke-test">Live proof</a> ·
  <a href="#how-it-compares">Compare</a> ·
  <a href="docs/JEV_FAST_AGENT.md">Fast JEV guide</a>
</p>

# BeatBrowser

Give any MCP-capable agent control of **your signed-in Chrome**—with two ways
to drive the same local browser:

- **Normal** exposes 23 explicit MCP tools. The outer agent observes, reasons
  and calls each browser action itself. It needs no BeatAPI key.
- **Fast JEV** adds one optional bounded task executor. BeatAPI JEV selects from
  the current legal operations and DOM targets, while local code validates,
  executes and verifies every step.

Both modes use the same Chrome extension, loopback bridge, browser profile,
cookies and active sessions. Fast JEV is an execution mode, not a second
browser and not a replacement for the outer agent.

## Real browser-control smoke test

On 2026-09-20, the same signed-in X account published three approved replies in
each mode. All six replies were confirmed through permanent X status URLs.

| Mode | Verified | Total | Mean per reply |
| --- | ---: | ---: | ---: |
| Normal | 3/3 | 170.444 s | 56.815 s |
| Fast JEV | 3/3 | 36.240 s | 12.080 s |

The final Fast path was **4.7x faster** on this small workload. Its three
successful runs made 10 JEV calls and used 68,391 input tokens. At BeatAPI's
2026-09-20 JEV price of $0.042 per million input tokens with unbilled output,
that was about **$0.00287 total**.

This is a narrow browser-control smoke test (`n=3` per mode), not a general
reliability or performance benchmark. One Fast run initially reported a
verification false negative even though the reply had published; permanent-URL
recovery caught it. See [the complete evidence and boundaries](TEST_RESULTS.md).

## Two modes, one browser

| | Normal | Fast JEV |
| --- | --- | --- |
| Interface | 23 MCP browser tools | Optional `browser_task` or `beat-browser run` |
| Decision maker | Your outer agent | JEV chooses from a finite, current action space |
| Browser | Your existing signed-in Chrome | The same signed-in Chrome |
| BeatAPI key | Not required | Required for live JEV decisions |
| Best for | Exploration, debugging, unusual pages, human-guided work | Repetitive bounded flows with exact inputs and clear success checks |
| Verification | Outer agent reads tool effects and page state | Local assertions plus effect and durable-result checks |
| Fallback | Continue with any MCP tool | Stop and return control to Normal mode or a human |

Use **Normal** when the task is unfamiliar or requires flexible investigation.
Use **Fast JEV** when the goal, allowed domains, inputs and success condition
can be stated up front. A practical workflow is Normal once to learn the site,
save the non-obvious behavior, then Fast JEV for the repeatable path.

## Quick start

Requirements: Node.js 20+, Chrome, and an MCP-capable agent.

```bash
git clone https://github.com/BeatAPI/beat-browser.git
cd beat-browser
npm ci
node src/cli.js install
node src/cli.js doctor --json
```

Load the unpacked extension printed by `node src/cli.js extension`. Agent-led
installation details are in [AGENT_INSTALL.md](AGENT_INSTALL.md).

In a source checkout, use `node src/cli.js` where the examples below use the
installed `beat-browser` command.

### Normal mode

Start the standard MCP server:

```bash
beat-browser mcp
```

Your agent gets the existing 23 tools for tabs, snapshots, clicks, typing,
forms, network reads, screenshots, human handoff and site learnings. Browser
traffic stays between the local MCP process, `127.0.0.1` bridge and extension.

### Fast JEV mode

First validate the task locally. This makes no browser or model request:

```bash
beat-browser run --dry-run \
  --url https://example.com \
  --goal 'Check that the Example Domain page is ready'
```

For a live run, provide `BEATAPI_API_KEY`, explicitly enable Fast JEV and add
task-specific inputs/assertions when the workflow writes or submits data:

```bash
export BEATAPI_API_KEY='your-key-from-a-secret-manager'

beat-browser run --enable-fast-agent \
  --url https://example.com \
  --goal 'Check that the Example Domain heading is visible' \
  --max-steps 10 \
  --max-model-calls 20 \
  --timeout-ms 60000
```

To expose Fast JEV through MCP instead:

```bash
beat-browser mcp --enable-fast-agent
```

The added `browser_task` tool still requires `cloudConsent: true` for every
task. It sends bounded, redacted task/page state to the configured BeatAPI
endpoint. Cookies, storage dumps, authorization headers, raw HTML and
screenshots are not part of the JEV payload. Read the
[Fast JEV guide](docs/JEV_FAST_AGENT.md) and [privacy boundary](PRIVACY.md)
before enabling it.

## Why Fast JEV moves faster

Traditional browser-agent loops repeatedly serialize a page, ask a large model
what to do, then make one browser call. Fast JEV narrows each observation into
a typed decision problem:

```text
signed-in Chrome
      │
      ▼
structured live DOM ──► legal operations + compatible targets
                              │
                              ▼
                    one BeatAPI JEV request
                              │
                              ▼
                 local validation and live recheck
                              │
                              ▼
                    one action + local verify
```

JEV never returns selectors, coordinates, shell commands or JavaScript. The
extension keeps the real DOM node, rechecks it immediately before acting, and
stops on stale identity, domain drift, challenges, unsupported controls or
uncertain side effects.

## Learn once, reuse the path

BeatBrowser has two layers of site knowledge:

- Bundled notes in `docs/learnings/` ship with the project.
- Local notes under `~/.beat-browser/learnings/` stay on your machine and are
  not overwritten by upgrades.

Call `learnings({ domain: "x.com" })` before operating a known site. When the
page disagrees with a note, trust the page, finish carefully, then save the
corrected workflow. The X seed now includes the Fast JEV lessons from the live
test: active-tab rendering, contenteditable paste, exact accessible-name
narrowing, target-local freshness checks, post-submit settling and permanent
URL verification.

Fast JEV does not automatically upload local learning files. The outer agent
uses relevant notes to frame the bounded task; only the documented redacted
goal/page state crosses the Fast JEV cloud boundary.

Learnings are hints, never authority. They must not contain credentials,
cookies, private drafts, account data or unpublished user content.

## How it compares

| Approach | Browser/session | Control loop | Where BeatBrowser differs |
| --- | --- | --- | --- |
| Playwright/CDP and clean-browser agents | Often a new or specially launched browser; existing-profile support varies | General tool or script loop | BeatBrowser is extension-first and operates the Chrome profile already signed in by the user. |
| Screenshot-first computer use | Pixel observations and coordinates | Large-model reasoning for most steps | BeatBrowser prefers network/DOM evidence and stable local refs; pixels are a fallback. |
| [`huashu-chrome`](https://github.com/alchaincyf/huashu-chrome) | Existing signed-in Chrome through MCP + extension | Explicit tools, batching and learnings | BeatBrowser builds on this open-source foundation, keeps the Normal workflow, and adds the optional BeatAPI-backed Fast JEV executor. |
| [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast) | Browser Harness/CDP | JEV chooses a dynamic operation and target; a small LLM can write text | BeatBrowser adapts the bounded typed-decision pattern to its JavaScript MCP/extension stack and offers Normal and Fast JEV side by side. |

The two referenced projects evolve independently. The table describes the
reviewed repository designs, not sponsorship, feature parity or a universal
speed ranking. Attribution and pinned review sources are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What Fast JEV can and cannot do

Fast JEV currently supports visible, enabled controls in the top frame's light
DOM: click, exact text input, native select, scroll, wait and completion/block
decisions. It uses the same browser permissions as Normal mode. The caller or
outer agent decides which business actions are authorized; Fast JEV does not
add separate bans for payments, deletion, login, profile fields or downloads.

Technical limits remain: challenges, cross-domain drift, stale targets,
iframes, shadow DOM, canvas controls, file-input uploads, arbitrary keyboard
widgets and some custom dropdowns. An uncertain action returns control and is
never replayed automatically.

## Development

```bash
npm test
npm run check:syntax
npm run check:security
npm run build:extension
npm run benchmark:offline -- --iterations 3
```

The offline benchmark validates control flow and accounting with fixtures; it
does not establish real model latency. See [TEST_RESULTS.md](TEST_RESULTS.md)
for the live smoke test, offline evidence and known limitations.

## License and attribution

MIT — see [LICENSE](LICENSE).

BeatBrowser retains attribution to `huashu-chrome` and adapts ideas and
validation patterns from `browser-use/jev-ultrafast`. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details and upstream
licenses. BeatAPI and BeatBrowser do not claim an official partnership,
sponsorship or endorsement from Browser Use or TypeSafe.
