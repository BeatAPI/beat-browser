# Privacy

## Ordinary manual mode

BeatBrowser's ordinary MCP tools connect to a bridge on `127.0.0.1` and control
the user's Chrome through the extension. They require no BeatAPI signup or API
key, and the new fast-agent code adds no telemetry or background inference to
manual mode. Local configuration, bridge logs, audit records and saved site
learnings normally live under `~/.beat-browser/`.

The outer agent receives the results of the manual tools it calls. Its own
provider, client, retention settings and requested browser actions determine
where those results go. The browser continues to contact the sites it visits.
"Local bridge" does not mean that visited websites or an outer cloud agent
receive no data.

## Explicit fast-task cloud processing

The optional JEV executor is disabled by default. A CLI task must include
`--enable-fast-agent`. The optional `browser_task` MCP tool must first be
enabled for the server, and each call must include `cloudConsent: true`.
`--dry-run` validates local task configuration without opening a browser
connection, reading an API key or making network requests.

An enabled task sends a bounded, allowlisted model payload to BeatAPI:

- The caller's redacted goal and code-defined decision instructions.
- A sanitized page URL/title, a bounded visible-text excerpt and records for
  supported interactive controls, including safe labels, roles and state.
- A small history of recent actions and the finite legal choices for the next
  decision.
- If explicitly enabled, bounded redacted context for a separately configured
  text model to draft input for a caller-selected supported field.

The default endpoint is `https://api.beatapi.io`; a trusted local operator may
set `BEATAPI_BASE_URL`. The destination matters: the configured endpoint
receives the BeatAPI authorization key in the request header. Only the Node
process reads `BEATAPI_API_KEY`; the key is not sent across the extension bridge
or included in the model state or trace. Per-task MCP arguments cannot override
credentials, endpoint or model.

The fast path does not collect cookie or storage dumps, browser authorization
headers, raw HTML, screenshots, full network bodies or full page dumps for the
model. URLs are sanitized to remove query strings, fragments and userinfo.
Recognized password, credential, payment and personal data patterns are masked
from page context where possible, but their controls are not disabled by a
business-policy denylist. Structured element values are omitted
from the cloud snapshot; only a `valuePresent` boolean indicates whether a
field is populated. Text that the user enters or that a site renders can
later appear in visible page content; protection still depends on the bounded
redaction pass.

This redaction is a best-effort control, not a universal detector of personal
information or secrets in arbitrary natural language. A private name, unique
identifier, unpublished information or unusual secret may survive. Use fast
mode only for pages and goals whose remaining context may be sent to the
configured provider. This repository does not establish the provider's
retention, training or contractual terms.

## Local traces and existing logs

Fast traces use an allowlisted schema for timing and usage metadata, opaque
refs, decisions/probabilities, failure reasons and verification booleans.
Target names are replaced with categories such as `[button target]`, rather
than retaining actual page labels. Every provider request ID is replaced
with a truncated SHA-256 digest. The actual request ID is not retained, so
the trace cannot by itself provide that ID for a provider-support lookup.
This intentionally trades some diagnostic convenience for privacy.

Traces do not store full page bodies, raw provider responses, API keys, typed
input text or assertion values. Recognized sensitive patterns are redacted
again. A trace path can be selected with the CLI `--trace` option. Protect
these files as local operational records; metadata can still reveal task
timing and interaction patterns.

The original manual-mode bridge audit and learning facilities remain
available. These are separate from the fast trace format. Manual tools can
return sensitive page data when asked, and manually saved learnings should
never contain credentials or private drafts. Neither installing this change
nor running a dry run cleans older records.

## Scope of browser safeguards

The fast executor uses at most 32 exact canonical ASCII/punycode hostnames and
checks target links, redirects and current-page state. IPv6 and trailing-dot
hosts are unsupported. Actions and local element assertions are limited to
visible top-frame light DOM in the current viewport; iframes and shadow roots
are excluded. Local value assertions do not verify private field values.
Readable multilingual control labels are eligible regardless of business
meaning. Emoji-only targets remain unsupported because they do not provide a
stable readable identity. The caller or outer agent owns authorization policy.

This is an execution guard, not a network firewall.
Page scripts, subresources or redirects may contact another host before the
runner can detect the changed page and stop. Unsupported iframes and technical
failures are handed back to the outer agent or user. The existing `ask` panel
can request manual handling.

DOM checks and label/destination rules cannot establish that arbitrary page
JavaScript is benign. An otherwise eligible interaction can still trigger an
unexpected site-side effect. Fast runs and aborts stay pinned to the same
Chrome connection, response ownership is checked, and disconnected fast
commands are not queued for replay; these controls do not undo effects that
the site has already performed.

Source: [BeatAPI/beat-browser](https://github.com/BeatAPI/beat-browser).
