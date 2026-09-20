# X Reply playbook (BeatBrowser)

Sanitized operating notes for agents controlling a signed-in Chrome tab on `x.com`.
Sources: BeatAPI team X Reply runs + local beat-browser learnings (2026-08 / 2026-09).
Verify live DOM when X changes UI. Never store cookies, keys, or unpublished drafts here.

## Goals

Use this controller as the **hands** for an X Reply Agent:

1. Discover / open a status URL
2. Draft reply text outside the browser (BeatAPI Text API / plugin / skill)
3. Fill the composer with a reliable paste recipe
4. Click Reply only after explicit user approval
5. Prove success with a durable `https://x.com/<handle>/status/<id>` URL (not “clicked”)

## Session discipline

- Keep **one dedicated X tab** per batch. Pass the exact `tabId` on every command when multiple agents run.
- Background tabs on X often **do not render React**. If GraphQL returned 200 but `article[data-testid="tweet"]` is empty, select the tab with **focus:true**. Reload / waiting / screenshots without focus will not fix it.
- Before any mutation, verify the **visible signed-in handle**. Never silent-switch accounts.
- Call `learnings({ domain: "x.com" })` at session start when the host supports it.

## Reliable reply publish recipe (verified)

For each approved item:

1. `navigate` to the target status URL
2. `wait` for `[data-testid="tweetTextarea_0"]`
3. `click` that textarea to expand the composer (real click)
4. Paste the **full** reply with a forged ClipboardEvent (do **not** `type` then `paste` — that duplicates the first paragraph):

```js
(function () {
  var box = document.querySelector('[role="textbox"]');
  if (!box) return 'no textbox';
  box.focus();
  var dt = new DataTransfer();
  dt.setData('text/plain', FULL_TEXT_WITH_NEWLINES);
  box.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true
  }));
  return 'pasted';
})()
```

Notes:
- Prefer `[role="textbox"]` over nested contenteditable selectors that often miss.
- Newlines in paste become real blank lines; the `type` tool does not keep `\n`.
- CSP may block `const`/`let` in page eval — use `var` or an IIFE.

5. Click when enabled:

```js
(function () {
  var btn = document.querySelector('[data-testid="tweetButtonInline"]');
  if (!btn) return 'no button';
  if (btn.getAttribute('aria-disabled') === 'true') return 'disabled';
  btn.click();
  return 'clicked';
})()
```

6. Wait for network idle, then confirm `CreateTweet` or `CreateNoteTweet` **HTTP 200**.
7. Extract `rest_id` / `legacy.id_str` and build the durable reply URL under the approved handle.
8. Write back to your ledger. A tool receipt of “clicked” is **not** publication proof.

## Hard lessons

- Bring the tab to the foreground before submit — background clicks often no-op.
- Frequent automation can trigger Cloudflare / Arkose — hand off to the human.
- Do not forge GraphQL yourself (`x-client-transaction-id`); drive the page and read `network`.
- Search index is roughly last **30 days**; `min_faves` is soft — filter locally.
- Virtualized timelines unload off-screen tweets — accumulate with a MutationObserver while scrolling.

## Safety defaults for BeatAPI demos

- Separate authorizations: discover ≠ draft ≠ approve ≠ publish.
- Prefer human-in-the-loop for the final Reply click on brand accounts.
- Stop on rate limits, captchas, login challenges, or account mismatch.
- No cold DM automation in the default playbook.

## Related BeatAPI pieces

- X Reply Chrome plugin (draft UI): `BeatAPI/x-reply-plugin`
- X Reply Skill (batch state machine): `x-reply` skill (in this repo: skills/x-reply)
- Text generation: BeatAPI `POST /v1/chat/completions` (default DeepSeek Flash)
- Social discovery: BeatAPI Social Data actions
