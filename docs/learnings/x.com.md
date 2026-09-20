# X / Twitter browser-control notes

Verified on 2026-09-20 with the BeatBrowser Normal and Fast JEV modes. These
notes describe observed behavior, not a permanent X contract. Trust the live
page when it differs and update the learning after the run.

## Reply publish recipe

1. Use one dedicated task tab and keep it active long enough for X's SPA to
   render. A newly opened background status tab can have network data before
   its composer exists in the DOM.
2. Confirm the intended status URL and signed-in account before writing.
3. Find the live reply composer from a fresh observation. It is a
   `contenteditable` editor; a paste-style `ClipboardEvent` is more reliable
   than assigning `textContent` or an input value.
4. Bind the exact approved reply as caller input. Do not ask a decision model to
   rewrite approved text.
5. Narrow the final click to the exact accessible name when the page exposes
   several reply-related controls. On localized X, the plain Reply label can
   coexist with a Reply-to-author label and reply-count controls; exact-name
   narrowing prevents the wrong candidate from competing.
6. After the authorized click, allow a short reactive-page settle before
   evaluating success. A too-early check can report a false negative even when
   the reply has published.
7. Prove success with the newly created permanent
   `https://x.com/<handle>/status/<id>` URL. A click receipt, composer closing or
   model `DONE` is not sufficient evidence.

## Fast JEV operating notes

- Scroll until the composer is visible before expecting `TYPE_TEXT`; off-screen
  controls are intentionally absent from the action space.
- Readable Unicode control labels are valid. Do not infer business-action
  authorization from payment, destructive, account or credential keywords.
- Recheck the selected target's identity, visibility and geometry immediately
  before execution. Unrelated timeline counters and background DOM churn should
  not invalidate an unchanged selected target.
- An unrelated user tab opening in the same window is not task drift. A child
  tab opened by the pinned task is drift and should stop the run.
- For exact-input tasks, expose only matching fields and necessary scrolling;
  caller policy remains authoritative.
- Never automatically retry a reply/post click after an uncertain receipt. Read
  the page and recover the permanent URL first; retrying may publish twice.

## Normal-mode fallback

If Fast JEV stops on ambiguity, unsupported UI or verification uncertainty,
preserve its `tabId` and continue in Normal mode from a fresh snapshot. Do not
restart the entire task or discard an already published side effect.

Stop and hand control to the user on account mismatch, login challenge,
CAPTCHA, rate limit or any unapproved content. Do not store credentials,
cookies, unpublished drafts, account identifiers or personal data in learnings.
