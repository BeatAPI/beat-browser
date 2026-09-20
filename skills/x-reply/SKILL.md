---
name: x-reply-browser
description: Use when an agent must publish or fill an X (Twitter) reply in the user\'s signed-in Chrome via BeatBrowser. Covers tab focus, paste-into-draft-js, CreateTweet verification, and durable URL proof.
---

# X Reply via BeatBrowser

Read `docs/playbooks/x-reply.md` before the first live X action.

Workflow: open status URL → focus tab → paste full text → click reply when enabled → verify CreateTweet/CreateNoteTweet 200 → capture durable URL.

Never treat “clicked” as success. Never forge GraphQL. Stop on captcha or account mismatch.
