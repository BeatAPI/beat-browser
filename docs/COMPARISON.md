# Browser integration comparison

Reviewed on 2026-10-08. Compare the browser integrations themselves, not the
general abilities of their models or the hosts' support for third-party MCP.

## The distinction that matters

Claude Code with Claude in Chrome and OpenAI's desktop Chrome extension can
both work in an existing signed-in browser. Login reuse is useful, but it is
not unique to BeatBrowser. OpenAI's built-in Browser is a different surface:
it has its own browser profile, separate from regular Chrome.

BeatBrowser exposes a common local stdio MCP tool interface. A compatible
Claude Code, Codex CLI, Cursor or custom MCP client can connect without a
BeatBrowser-specific model subscription. The host agent still needs its own
model access and may apply its own tool permissions or organization policy.

The repository's useful combination is:

- Existing Chrome through an unpacked extension and loopback bridge.
- 23 Normal-mode tools, including DOM refs, batched `act`, effects and assertions.
- Editable, local site notes that different clients can read through `learnings`.
- A local command audit with best-effort parameter redaction.
- Optional Fast JEV, with typed choices and local target/identity checks.

These are implementation facts, not proof that other tools lack equivalents.
Do not use a checkmark matrix to turn undocumented competitor features into
negative claims. Do not claim universally faster, safer, cheaper or more
reliable execution without comparable measurements.

## What the official sources establish

| Source | Verified scope |
| --- | --- |
| [Claude Code Chrome integration](https://code.claude.com/docs/en/chrome) | Shares browser login state; supports browser/coding workflows, site permissions, challenge handoff and GIF recording. Requires a direct Anthropic plan and supported sign-in; API-key and third-party-provider sessions have restrictions on the native Chrome integration. |
| [OpenAI Browser](https://learn.chatgpt.com/docs/browser) | Desktop built-in browser has a separate profile; supports preview, annotations, rendered-page interaction and optional developer mode. Use the extension for regular browser context. |
| [OpenAI browser extension](https://learn.chatgpt.com/docs/chrome-extension) | ChatGPT Work/Codex desktop can operate supported regular browsers through the extension; website access is controlled in the product. |

Native integrations can be the better choice for someone staying in one host
and wanting the vendor's setup, approvals and debugging experience. BeatBrowser
is useful for a user who changes agents or wants to inspect/adapt a common
browser toolkit. Availability and permissions remain host- and account-dependent.

## Engineering alternatives

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) supports its own
  browser automation workflow; extension mode can connect to an existing
  Chrome/Edge browser. Do not describe all Playwright workflows as fresh-profile
  only. Its testing/headless ecosystem serves different tasks well.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  focuses on browser debugging and performance. Read its current connection
  options before claiming that every setup needs custom launch flags.

## Our limits

BeatBrowser does not ship a cloud browser, a turnkey store extension, isolated
concurrent writers, verified per-profile selection in Normal mode, or a universal
approval policy. Some tools can write directly. Normal allowlisting covers only
URL-bearing commands. The loopback bridge is not cryptographically paired to its
extension and assumes a trusted local machine.

Fast JEV is optional, with narrower DOM/action support and explicit cloud consent.
The historical X timing smoke test in TEST_RESULTS.md is not a native-tool A/B
test. It must not appear as a speed win over Claude or Codex.

## Suggested public wording

> Your Chrome. Your choice of agent. BeatBrowser gives local MCP clients a common
> toolkit for your signed-in Chrome, with batched actions, editable site notes and
> a local audit trail.

Avoid: "Only BeatBrowser uses your logins", "Claude/Codex cannot do browser
tasks", "all operations stay on your machine", "automatic learning", or
"every sensitive operation is blocked".
