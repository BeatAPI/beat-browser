# x.com (also twitter.com)

Verified on a signed-in Chrome profile, 2026-08 to 2026-09. X changes its UI often: when the live page disagrees with this note, trust the page and correct the note.

## Rules that decide whether a run works

- **Background tabs do not render X.** In a background tab the GraphQL call can return 200 while `article[data-testid="tweet"]` never appears (`document.querySelectorAll('article').length === 0`), and screenshots without focus force no frame. Reload, waiting, and screenshots do not fix it. Select the tab with `focus: true`. Diagnosis: a large 200 response in `network` plus an empty DOM means rendering is frozen, not that there are no results.
- **Never forge X's GraphQL requests.** Replaying `/i/api/graphql/<queryId>/...` with `fetch` returns 403, because X signs every request with `x-client-transaction-id`. Drive the page so it sends its own requests, then read them with `network`. Tip: `network` with `body:"SearchTimeline"` and `maxBody:300` prints the full request URL, which is the easy way to confirm a queryId.
- **Draft.js only accepts paste.** Injected text and `type` do not stick (or drop newlines). Use the paste recipe below.
- **Verify the visible handle before any mutation.** Never switch accounts silently.

## Reply publish recipe (verified, batches of 10 and 200)

Per item:

1. `navigate` to the exact status URL.
2. `wait` for `[data-testid="tweetTextarea_0"]`.
3. `click` that textarea to expand the composer (needs a real event).
4. `eval` a forged paste of the FULL reply. Do not `type` first and then paste: the paste's selectAll can miss the typed text and duplicate the first paragraph.

   ```js
   (function () {
     var box = document.querySelector('[role="textbox"]');
     if (!box) return 'no textbox';
     box.focus();
     var dt = new DataTransfer();
     dt.setData('text/plain', FULL_TEXT_WITH_NEWLINES);
     box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
     return 'pasted';
   })()
   ```

   - Use `[role="textbox"]`. `[data-testid="tweetTextarea_0"] [contenteditable="true"]` finds nothing.
   - `\n\n` in the pasted text becomes real blank lines; the `type` tool does not keep `\n`.
   - The page CSP blocks `const` and `let` in eval: use `var` or an IIFE.
5. `eval` the submit check, then click only when enabled:

   ```js
   (function () {
     var btn = document.querySelector('[data-testid="tweetButtonInline"]');
     if (!btn) return 'no button';
     if (btn.getAttribute('aria-disabled') === 'true') return 'disabled';
     btn.click();
     return 'clicked';
   })()
   ```
6. Confirm with `network` `match:"CreateTweet"` (short replies) or `match:"CreateNoteTweet"` (long, multi-paragraph replies). A 200 POST from either is success; read `rest_id` (or `legacy.id_str`) from the response.
7. Build the durable URL `https://x.com/<handle>/status/<rest_id>` from that id. "clicked" is never proof of publication.

Pre-submit steps 1 to 3 as one runnable playbook (fill `{{STATUS_URL}}`):

```act
[
  {"do": "navigate", "url": "{{STATUS_URL}}"},
  {"do": "wait", "for": "selector", "selector": "[data-testid=\"tweetTextarea_0\"]", "timeout": 15000},
  {"do": "click", "selector": "[data-testid=\"tweetTextarea_0\"]"}
]
```

Other reply facts:

- Pasting text that contains a URL makes X fetch a link card preview automatically.
- Foreground the tab before submitting: a click in a background tab often does nothing.
- Frequent automation can trigger Cloudflare or Arkose challenges. Hand those to the user (`ask`), never work around them.
- X Articles have reply sections. The reply textbox appears after scrolling to the bottom of the article page, and it submits through the same `tweetButtonInline` control.

## Reading pages reliably

- `snapshot` can come back empty for X in a background tab. `read_text` still returns the real content. Check with `read_text` before ever treating a post as unavailable, and only call it unavailable when both agree the content is missing.
- After a submit or any re-render, element refs go stale. Switch to `selector` or `find` (role + name) instead of reusing refs. Stale refs are the most common failure in long batches.
- Chrome tabs can vanish during long sessions. If one is lost, open a new one (`tabs` with `action:"new"` and a label), navigate to the target, and continue. Keep a mapping of item to tabId.
- `tabs new` once returned a wrong tabId. Listing tabs and reusing an existing x.com tab is steadier.
- A status page with video can make `wait for selector` fail with `[DIALOG_BLOCKING] page script did not respond for 25 seconds` (heavy scripts, not a real dialog). Do not chain 6 navigate+wait steps in one `act`; `navigate`, then read separately.
- All the numbers of a post are in one place: each `article[data-testid="tweet"]` has a `div[role="group"]` whose `aria-label` looks like `264 replies, 687 reposts, 6523 likes, 3355 bookmarks, 1778078 views`. When judging real reach, trust reposts > bookmarks > likes > views.
- The user timeline endpoint is `UserOriginalsTimeline`, not `UserTweets`.
- GraphQL responses are deeply nested: recurse for `__typename === 'Tweet'` plus `rest_id` instead of hardcoding a path.
- Images: append `?format=jpg&name=large` for the original. Video: pick the highest bitrate in `video_info.variants`.

## Search

- The search index covers roughly the last 30 days. A `since:` earlier than that makes `SearchTimeline` return only a cursor and zero items; it is a platform limit, not a thin result set.
- `min_faves:100` is soft: an 83-like post can slip through. Filter locally after collecting.
- Quoted phrase + time window + like threshold together almost always return nothing. Broad terms give volume. `lang:en` helps.
- The search timeline is virtualized: once you scroll down, earlier `article` nodes are unloaded and re-reading returns 0. Inject `window.__seen = {}` plus a `MutationObserver` that accumulates tweets, scroll a few rounds, then read `window.__seen` once. Globals survive across `eval` calls on the same page; a full `navigate` clears them.
- Long posts (over 280 chars) are truncated to "Show more" in the search stream. `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<tok>` works without login for the full text of short posts, but long posts only return `note_tweet: {id}`; for those, navigate to the status page and read `[data-testid="tweetText"]`. The token is `((id/1e15)*Math.PI).toString(36)` with `0` and `.` removed.

## X Articles editor

- Do not `snapshot` or `act` on this page. The editor renders every paragraph as 5 textboxes in the accessibility tree and one snapshot costs 30k+ tokens. Read state with `eval`, click with `eval`, and use `screenshot` only when necessary.
- An empty editor renders at size 0, so `snapshot` cannot see it; use `selector`.
- `input[type=file][data-testid="fileInput"]` exists (accepts jpeg/png/webp only, not GIF), but the image lands at the cover slot rather than at your `Range` cursor and opens an "Edit media" dialog. To place an image at a specific paragraph, use drag and drop (`dropSelector`) or a human.
- Verify what landed on the Preview page: count `img[src*="media/"]` and `video`. The "N words" label is unreliable for CJK text. In one run an external tool reported 10 images and 6 landed (GIFs became `video.twimg.com/tweet_video/*` videos, 4 jpgs were lost, and images shifted against paragraphs). The preview page is not virtualized, so a whole-page count is safe.
- A new draft takes 20+ seconds to load; `wait for text` times out. Use `wait idle` and a screenshot to check the spinner. "Uploading media…" shows in `#detail-header` and disappears when done.
- The Publish button's text is exactly "Publish". Pass the image-count gate above before clicking it.

## Throughput (batch replies)

- Each model turn costs about 15 to 30 seconds. Over 200 items, turns dominate the runtime, so merge every predictable step into one `act`. Steps 1 to 3 above are one `act`; steps 4 to 6 are the two `eval` calls plus one `network` read. Extract the reply id with one `eval` after submit instead of navigating to the profile.
- `act` stops at a submit-type control unless `allowSensitive` is set; keep that off for the Reply click so the final activation stays a separate, deliberate call.
- Stop immediately on rate limits, CAPTCHA, login or identity challenges, account warnings, duplicate-content warnings, or an account mismatch.
- If a call times out or disconnects after a possible Reply activation, treat it as `post_unknown`: check the target page and the account's replies before doing anything, and never resubmit blindly.

## Related

- `docs/playbooks/x-reply.md`
- `docs/playbooks/x-reply-team-pack.md`
- `skills/x-reply/SKILL.md`
