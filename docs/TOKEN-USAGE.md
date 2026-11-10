# QQ Bridge token diagnosis and local optimization

Status: local changes only. Deploy only after review. No wake probability, proactive schedule, sleep duration, conversation admission, model, or reasoning configuration was changed. SSH was used to read configuration, aggregate logs, and validate compaction settings; the running application was not modified.

## Evidence and accounting

[Sanitized evidence](token-usage-evidence.json) comes from the two currently mapped DSH conversation logs and nine slang-learner logs. No raw conversation text or credentials are included. The group log ends at 2026-11-09 02:50 UTC; these are recorded-session samples, not account-wide billing totals. The server uses `replyBackend: dsh`, provider `deepseek-vision`, model `deepseek-flash`, and low reasoning.

The installed DeepSeek adapter subtracts cache hits from `inputTokens`. Thus fresh and cached inputs below are disjoint and must be added to get total prompt tokens. Reasoning is part of output and must not be added twice. Cached tokens still represent repeated input processing; their billing rate differs from fresh input. These logs do not establish a dollar cost.

| Recorded sample | Turns | Model steps | Fresh input | Cached input | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Group, whole recorded session | 1,762 | 6,207 | 6,331,004 | 3,302,287,744 | 687,369 |
| Group, last 100 turns | 100 | 334 | 219,191 | 223,549,952 | 32,423 |
| Private chat, last 100 turns | 100 | 197 | 148,363 | 67,880,576 | 9,566 |
| Slang learners, nine sessions | 793 | 788 | 654,002 | 114,592,256 | 108,260 |

## Findings, in priority order

1. **History retention is the dominant amplification.** In the group's last 100 turns, a model step replays a median 666,747 input tokens and up to 788,699. Almost all are cached. There are only 32,423 output tokens in this sample. The adapter advertises a 1,000,000-token context and the preset leaves compaction at the installed defaults: trigger at 80% capacity, retain 16%. This makes a casual conversation carry hundreds of thousands of tokens of old tool exchanges. Seven historical compactions each processed roughly 461,000–484,000 input tokens as well; those separate summary requests are not included in the assistant-step totals above.
2. **Tool control loops multiply that large history.** Last 100 group turns: 151 waits, 63 read acknowledgements, and 17 message-send calls across 334 model steps. Waking naturally is intentional; the avoidable cost is replaying the accumulated history at every continuation. A wait's elapsed wall time itself does not use inference tokens, but resuming after the tool result does.
3. **Repeated instructions and acknowledgements accumulate.** The median recent group wake is 1,830.5 characters. Each wake repeats sticker strategy and sleep/participation instructions already supplied by the persona. `qq_mark_read` responses average about 1,205 characters across the whole group log, largely by echoing wake configuration and safety metadata. That state is already available through explicit state tools.
4. **The static header is also large.** The latest header contains a 15,908-character system string and 29,833 characters of tool schemas for 44 tools. Four skillhub schemas are advertised despite being rejected by the execution guard. Character counts are not token counts.
5. **Background learning is an additional consumer.** Slang extraction accounts for 793 turns in nine recorded sessions even though automatic research is disabled. No learning feature is disabled in this patch.
6. **Private proactive wakes are visible but intentional under the requested behavior.** Of the last 100 private turns, 97 are proactive opportunities, two reminders, and one ordinary wake. This is a secondary operational observation, not a reason to suppress social participation in this patch.

## Local changes

- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`: exact-model compaction policies for `deepseek-vision/deepseek-flash` and `deepseek-official/deepseek-flash`. Trigger at 80,000 tokens on the deployed 1M context, retain a 16,000-token recent tail, and cap the summary output at 2,048 tokens. Other models keep their existing defaults. The installed rc.7 policy resolver accepted both policies and resolved these exact budgets in an isolated, read-only validation.
- `src/social/wake-triggers.js`: a compact wake base keeps the current persona reference, session token, live status, wake configuration, memories, participation context, sticker choices, and the runtime observation duration. Repeated prose becomes a short reminder; the complete persona, tool instructions, and server-side waiting checks remain available. Synthetic wake fixtures shrink 55–65% in characters, depending on reason. This is a prompt-size measurement, not a measured total-token or bill reduction.
- `src/mcp/*.js`: JSON tool responses use compact serialization. A successful `mark-read` acknowledgement retains its confirmation fields and `wakeGuaranteed` but omits the repeated full `wakeConfig` and `wakeSafety`. The console API and explicit social-state tool still return the full state. Wait results, complete message content, errors, and timing fields are preserved.
- `dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs`: hide the four skillhub schemas that the guard already rejects. Allowed QQ, web, and model-side tools remain available.
- `src/bridge/config.js`: optional local rollback switches `tokenOptimization.compactWakePrompt: false` and `tokenOptimization.compactToolResults: false`. Compaction policy changes are reverted in the preset, separately.

[Optimization-only patch](token-optimization.patch) shows the changes against the already split source, excluding the earlier module refactor.

## Validation and practical limits

`npm run test-tokens` checks prompt-size reductions for eight wake reasons, retained dynamic context, unchanged observation duration, compact JSON parsing, full wait payload preservation, error preservation, and tool restrictions. `npm run test-modules` exercises isolated startup, routes, authentication, mode changes, token rotation, send-failure rollback, module sizes, and 36 MCP registrations. Static checks cover unresolved identifiers and JavaScript syntax. Existing Markdown, slang, and sticker checks are also run.

The major saving depends on the installed DSH applying the new compaction policy to existing sessions. A full runtime compaction and live QQ behavior test has not been performed. More frequent compaction can lose old details and adds summary calls; the 16K recent tail and bridge's independent recent-message/memory stores reduce that risk but do not eliminate it. Exact policies were validated using the installed resolver extracted in memory; this does not prove end-to-end preset reload or compaction behavior.

After deployment, verify that the installed `~/.dsh/.agent-presets/qq-chat-v2/` copy matches the reviewed preset, and that the owning DSH process has reloaded it. Updating only the repository copy is insufficient. Preserve the existing session logs and persistent bridge memories. Compare the next 100 turns with this baseline: fresh input, cached input, output, steps per turn, compaction count/cost, latency, and whether replies remain contextually appropriate. Do not reset or archive conversations merely to produce a lower token count.

No percentage reduction in total cost is claimed before that measurement. The intended improvement is to keep the same social wake opportunities while bounding the conversation carried into each model step.

## Round 2: fewer model steps per wake

Each model step replays the whole history, so removing steps matters more than shortening prompts.

- **Unread messages in the wake prompt** (`src/social/wake-triggers.js`). Up to `socialV2.context.wakeUnreadInline` (default 15) unread messages are appended as one line each: `#seq sender(userId)[flags]: text`. Chat text is untrusted, so newlines are flattened and `【】` become `[]`, which stops a message posing as a bridge header. The `seq` already works as `replyToMessageId`/`messageId`. This removes the `qq_get_unread_messages` step from a typical wake. Switch: `tokenOptimization.inlineUnread: false`.
- **Server-side pre-sleep observation** (`src/console/wake-config.js`, `src/social/wake-triggers.js`). `qq_mark_read` / `qq_set_wake_config` no longer reject with "wait 5 minutes first". They succeed and set `preSleepObserveUntil`. The window is the remainder of `preSleepWaitMs` since the last incoming message, or since the bot's own last message (this replaces the prompt-only rule "after replying, wait for an answer"). Any message or poke in that window wakes the model with reason `preSleepObserve`. That wake is exempt from wake rate limits and counts as an observation, so the model may go back to sleep directly. `qq_wait_for_messages` still works and still satisfies the old rule. Switch: `tokenOptimization.deferPreSleepWait: false`, which restores the 400 response and the old wake wording.
- The persona (items 4, 5, 7, 10, 12, 13, and the waiting section) and the three tool descriptions now describe this flow. If they kept the old "must wait 300000 ms" text, the model would keep waiting and nothing would be saved. With the switch off, the restored 400 error tells the model how to wait, so the persona text stays usable in both modes.
- Slang learner sessions are archived after each task (`tokenOptimization.freshLearnerSession: false` to keep one session). Chat-history tool results drop duplicated/empty fields and media URLs. The v2 preset no longer mounts `todo_write`/`ask_user_question` and hides the SnowLuma host tools, `qq_status`, `qq_list_groups` and `qq_get_group_history`.

Compare after deployment: steps per turn (baseline 3.34 in the group), `qq_wait_for_messages` and `qq_get_unread_messages` calls per 100 turns, `preSleepObserve` wakes, and reply latency to answers given right after the bot spoke.

## Round 3: oversized tool results

- `web_fetch` (`src/mcp-web-search-safe.js`) returned up to 50,000 characters of raw HTML as indented JSON, and the pruner (threshold 50,000) let it through. It now reads up to 300,000 raw characters, strips tags/scripts/styles (`htmlToText` in `src/safe-fetch.js`), and returns at most 8,000 characters of text. `web_search` JSON is no longer indented.
- Tool-result pruner: `thresholdChars` 50000 → 20000, `headChars` 45000 → 16000.
- `qq_set_wake_config` success reply drops the echoed `wakeConfig`/`wakeSafety` and keeps `sleepUntil`, normalised `speakerIds`, and `wakeGuaranteed` (same as `mark-read`). Errors are unchanged.
- `qq_send_group_message` / `qq_send_private_message` are hidden and rejected in the v2 preset; `qq_send_message` covers both.

## Round 4: fewer steps per turn

Measured on the server (read-only) on 2026-11-09, deployed build = round 1 only (rounds 2–3 were not yet installed):

| DSH session | Window | Turns | Steps/turn | Prompt tokens/step |
| --- | --- | ---: | ---: | ---: |
| Group | last 100 before deploy | 100 | 3.19 | 681,387 |
| Group | after deploy | 4 | 3.50 | 61,255 |
| Private | last 100 before deploy | 100 | 1.97 | 345,325 |
| New session | after deploy | 13 | 7.00 | 49,912 |

Compaction works (~11× less per step). Steps per turn did not fall: almost every turn is `wait(120000)` → `mark_read`, plus a final step. Journal since 2026-10-26: 1,420 `mark_read`, 33 `set_wake_config`, 121 wrap-up reminders and 432 resets to the default wake config after missed wrap-ups; wake reasons: probability 2,398, question 557, atMention 339, proactiveCheck 282, poke 164.

- **Implicit wrap-up** (`src/events/mux.js`, `markReadV2` in `src/social/wake-triggers.js`). A completed turn without `qq_mark_read`/`qq_set_wake_config` is treated as mark_read with the current wake config: unread shown in that wake is cleared (later arrivals stay unread so queued wakes still fire), background pre-sleep observation applies, and no reminder turn is sent. It also no longer counts as a no-action turn, so a run of quiet passes does not reset the model's wake config. Failed/aborted turns keep the reminder. The mark-read endpoint uses the same helper. Wake prompts and the `mark_read`/`set_wake_config`/`wait` descriptions say "just end the turn". Switch: `tokenOptimization.implicitWrapUp: false`.
- **Proactive backoff** (`src/social/wake-timers.js`). While nobody has spoken since the last proactive wake, each proactive wake halves the next chance (floor 1/16); any incoming message or poke resets it. Persisted in social state. Switch: `socialV2.proactive.backoff: false`.
- **Persona** (`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`): 12,731 → 4,787 characters. Repeated rules merged (spaces ×4, wait-for-unfinished ×3, wrap-up ×4, autonomy ×2), the tool cheat sheet removed (schemas carry it), waits limited to clearly unfinished messages (timeout 30–60 s), and a rule that each tool call costs a full-context step. Safety rules unchanged. Literal block (`|-`) so line breaks reach the model.

Expected after deploying rounds 2–4 together: a quiet pass is 1 step (was `wait` → `mark_read` → end = 3), a reply is about 2. Compare steps/turn, `qq_wait_for_messages` per 100 turns, `turn_end` log lines, reminders, and proactive wakes in private chats.

## Round 5: reuse stable session context

Character cards are injected at the delivery boundary on first use and when edited, rather than prepended by each incoming-message builder. V2 rules, sticker summaries, and the slang glossary are sent once and updated when changed. Routine wakes retain new messages, session token, wake reason, and live state. Compaction invalidates the receipt; restart/new sessions and a 16-prompt refresh restore context. Rollback: `tokenOptimization.reuseSessionContext: false`. Codex/failover remains self-contained.

Local lifecycle and integration checks pass. Equivalent synthetic payloads shrink from 803 to 332 characters for a routine v2 wake and from 3,535 to 75 for an ordinary message with a card. DSH still includes its system prompt and retained history in model calls. These are bridge payload measurements, not measured token savings. SSH is blocked in this session, so this round is local only. See [implementation and verification details](SESSION-CONTEXT-REUSE.md) and [sanitized test evidence](session-context-evidence.json).

## Round 6: remove repeated wake scaffolding

Routine wakes no longer append the context revision/role reference, recovery reminder, token, unchanged memory, wake settings, duplicated latest-message summary, or long participation advice. Tokens, wake settings, and complete memory snapshots use accepted-delivery receipts alongside the existing context sections. Updated snapshots replace all old memory, including removed categories. Stable topic timestamps prevent every passing minute from resending memory. Current time remains once, to the minute with its timezone; activity becomes one brief count line. Unread message boundaries, escaping, sequence IDs, and older-unread notices remain.

The previous local fixture was rerun from the saved source baseline: routine v2 wake **332 → 91 characters**; ordinary message **75 → 37**. These fixed-time synthetic fixtures measure bridge payload size, not billed tokens. Token rotation, compaction/restart recovery, periodic refresh, rejected/failed submissions, queues/media, and the self-contained Codex/failover/rollback paths pass local checks. This round has not been deployed. See [details](WAKE-PAYLOAD.md) and [current evidence](wake-payload-evidence.json).
