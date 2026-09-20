# x.com — BeatAPI X Reply team playbook

This is a sanitized experience pack for agents using `beat-browser`. It contains reusable operating facts, not credentials or production records. Page behavior can change; verify the live page and update the local note when evidence disagrees.

## Session and tab discipline

- Run `doctor` or otherwise confirm that the bridge and approved signed-in Chrome extension are online before browser work.
- List current sessions and tabs, then create or claim one clearly labelled X tab for the batch.
- Pass the exact `tabId` on every call when more than one agent or work line is active.
- Verify the visible active X handle before any mutation. Never switch accounts silently.

## Read and draft

- Open the exact numeric status URL and verify the expected author, visible source content, replyability, and current metrics.
- Use the approved batch draft exactly. Normalize whitespace only for comparison; do not silently rewrite or change the destination.
- Fill the composer and verify that the complete draft is present before treating the final Reply control as eligible.
- Keep content matching, useful contribution, and product bridge as one natural response. Use at most one approved destination.

## Submit once and prove the result

- Final Reply activation is a separate action and requires explicit publication authorization for the exact target, account, copy, and link.
- Activate the final Reply control at most once after prechecks. A tool receipt saying "clicked" is not publication evidence.
- After any possible activation, a timeout, disconnect, or ambiguous result is `post_unknown`. Do not resubmit blindly or switch controllers and try again.
- Verify the matching reply under the exact target and on the approved account's replies surface.
- Capture only the durable `https://x.com/<approved-handle>/status/<numeric-id>` URL, then write it back before moving to the next item.

## Stop conditions

- Stop immediately on rate limits, CAPTCHA, login or identity challenges, account warnings, duplicate-content warnings, or account mismatch.
- A deleted, locked, unavailable, or non-replyable target may be recorded as `target_unavailable` only with visible evidence.
- Never mark a reply published without a unique durable URL and successful workbench reconciliation.

## Experience hygiene

- At session start, call `learnings({ domain: "x.com" })`.
- At session end, save only newly proven, reusable mechanics or corrected stale behavior.
- Read the current local note first and merge it; `save` replaces the entire local note.
- Never put API keys, cookies, tokens, personal data, private URLs, unpublished drafts, or production batch contents in an experience pack.
