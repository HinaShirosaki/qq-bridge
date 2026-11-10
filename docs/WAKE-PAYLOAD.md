# Compact wake payloads

Local source change, 2026-11-09. This cleanup has not been deployed or measured on live traffic. Wake admission, probabilities, schedules, and the server's observation window are unchanged.

Routine DSH v2 wakes now look like this synthetic example:

```text
2026-11-09 15:30 America/Chicago
【唤醒】group:123；@我
近5分：群2条/2人，你1条。
【未读消息】
#7 A(9)[@我]: new message
【未读消息结束】
```

The activity line is omitted when the recent five-minute window is empty. A brief unfinished-message cue is included when applicable. With inline unread disabled, the wake instead gives the unread count; truncated inline lists retain the older-unread notice. User names, message text, and trigger labels cannot forge bridge headers or line breaks.

| Previously repeated section | Current behavior |
| --- | --- |
| 沿用上下文 / revision hash / role name | Omitted; unchanged context remains in the session |
| 上下文恢复 reminder | Supplied in the session rules |
| 会话令牌 | Sent on first use, rotation, or context refresh |
| 当前唤醒 settings | Sent on changes/refresh, without counters or last-wake metadata |
| Memory | Complete replacement on changes/refresh; empty state explicitly clears old memory |
| 此刻状态 | No duplicate unread count or latest-message excerpt; retain the unfinished-message cue |
| 参与度参考 | Five-minute group message/member counts and the bot's message count |
| 当前时间 | One timestamp to the minute, with timezone, without the heading |
| Long unread instructions | Supplied in session rules; retain inline boundaries and escaping |

Only accepted submissions advance context receipts. New sessions, token rotation, bridge restart, compaction invalidation, and the existing 16-prompt refresh restore the full context. Failed/rejected submissions leave changes pending. The full console/state tools retain their detailed views. The `local-codex`/DSH failover path and `tokenOptimization.reuseSessionContext: false` continue using self-contained prompts.

Memory topic timestamps are absolute in context snapshots; age labels in full state tools remain relative. This avoids re-appending an unchanged memory solely because another minute passed. Deleted categories replace their entire old memory snapshot; expired pending thoughts and stale-topic transitions remain visible on the next delivery.

The saved pre-change implementation and its original fixture were rerun locally. Compared with the current [fixed-time synthetic fixture](wake-payload-evidence.json):

| Fixture | Before cleanup | After cleanup | Reduction |
| --- | ---: | ---: | ---: |
| Routine v2 wake, one unread message | 332 characters | 91 characters | 72.6% |
| Ordinary message | 75 characters | 37 characters | 50.7% |

These fixtures use mocked time/activity text. The integration suite separately checks the real timestamp wrapper; lifecycle tests exercise real compact participation and stable memory formatting. DSH still submits retained history and tool/system context on each step. These character counts do not establish billed-token savings or production response quality.

Validation: `npm run test-tokens`, `npm run test-modules`, `npm run test-slang`, `npm run test-md`, and syntax checks of changed JavaScript passed. Coverage includes all wake reason families, settings/memory updates and clearing, stable memory ages, escaping, inline-off/truncated unread lists, token rotation, compaction, retries, queues/media, and self-contained fallback. To regenerate current evidence: `node scripts/test-session-context.mjs --report docs/wake-payload-evidence.json`.

Implementation: [context delivery](../src/messaging/context.js), [wake building](../src/social/wake-triggers.js), [state formatting](../src/social/state.js), and [timestamp wrapper](../src/slang/learning.js). Deployment must include both source and the installed DSH preset copies; this round changes the persona's token/context instructions as well.
