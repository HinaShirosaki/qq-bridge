# Reuse stable QQ prompt context

Implemented locally on 2026-11-09. SSH inspection failed with `Operation not permitted`; no current server transcript was fetched and this change has not been deployed. Earlier deployment records describe earlier releases.

Ordinary incoming messages, private replies, proactive/exit prompts, and summaries previously embedded the character card in their prompt text. Every v2 wake repeated behavior instructions and sticker suggestions; the delivery wrapper also repeated the slang glossary. These copies accumulated in the DSH session history.

The delivery boundary seeds stable context in the first accepted prompt for a DSH session. Later prompts carry only changed context sections, without a context-reference hash. Ordinary messages carry their chat content; v2 wakes carry a short timestamp, reason, unread messages, and compact activity/unfinished-message cues. Session tokens, wake settings, and complete memory snapshots are included at first use and when changed or refreshed. The full card remains available through `qq_get_prompt` when needed. See [wake payload cleanup](WAKE-PAYLOAD.md) for the latest local changes.

This prevents adding duplicate context to history. DSH still submits its system prompt, tool schemas, and retained history to the model on each inference step. This change does not make the underlying model API stateful or remove cached-input billing.

## Recovery and behavior

- Role edits, role removal, glossary/sticker changes, and behavior-policy changes update the relevant section. Empty sections explicitly clear old context.
- A new DSH session, bridge restart, mode change, or session-token rotation seeds context again. Receipts are held in memory and bounded to 256 sessions.
- `compaction/end` invalidates the receipt. If that event is unavailable, a full refresh follows every 16 accepted prompts. A v2 agent missing its card can also call `qq_get_prompt` once. Immediate post-compaction model behavior remains unverified on the server.
- Preparation happens after session creation and media resolution. Only accepted submissions record a receipt. Rejected or failed submissions retry with context; compaction during a pending submission wins over its old receipt.
- The existing per-conversation prompt queue serializes updates. Media and unread-message escaping are preserved. Wake admission, probabilities, schedules, and conversation history are unchanged by this patch.
- `tokenOptimization.reuseSessionContext: false` restores self-contained prompts. The `local-codex`/DSH failover route also stays self-contained because the two backends maintain separate histories.

## Local validation

`npm run test-tokens` includes the new delivery-level lifecycle checks. `npm run test-modules` checks the real mux compaction handler and slang wrapper, startup/routes/authentication, module sizes, and all 36 MCP tool registrations. Markdown and slang checks pass. Syntax checks passed for 47 source/test JavaScript files.

[Original synthetic evidence](session-context-evidence.json), recorded before the later [header cleanup](wake-payload-evidence.json), compares equivalent messages using the rollback and reuse paths:

| Prompt | Previous characters | Reused characters |
| --- | ---: | ---: |
| Routine compact v2 wake, one unread message | 803 | 332 |
| Ordinary message with a character card | 3,535 | 75 |

The first request is deliberately larger because it includes the full session context. These counts describe synthetic bridge payloads; they are not live token or cost savings. The tests cover context edits/removal, retries, compaction, periodic refresh, media, concurrent/offline queues, restart, ordinary chat, and rollback without sending QQ messages.

## Deployment verification still required

Recheck live source and configuration over SSH before applying this change; do not reuse the stale optimized archive. Sync both repository and installed DSH presets (`qq-chat` and `qq-chat-v2`), preserve state/session IDs, and restart their owning systemd services after staged checks. Verify the next natural wakes have one initial context update followed by messages and changed context sections only. Check fresh/cached input, steps per turn, compaction, and role continuity before claiming live savings.

Implementation: [`messaging/context.js`](../src/messaging/context.js), [`social/conversation.js`](../src/social/conversation.js), [`social/wake-triggers.js`](../src/social/wake-triggers.js), and [`events/mux.js`](../src/events/mux.js). Regression coverage: [`test-session-context.mjs`](../scripts/test-session-context.mjs).
