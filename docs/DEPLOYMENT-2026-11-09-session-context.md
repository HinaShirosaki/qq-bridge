# Deployment: reuse stable session context

Deployed over SSH on **2026-11-09 at 21:06 UTC**. This supersedes the local-only deployment status in `SESSION-CONTEXT-REUSE.md` and round 5 of `TOKEN-USAGE.md`.

- The live runtime source matched the inspected pre-change baseline. Only 16 changed implementation, preset, test, package, and implementation-note files were installed; unrelated files were preserved.
- Staged checks passed on the server with Node v24.19.0: token optimization, session-context lifecycle, module integration, Markdown, slang, and source syntax. The initial staging copy lacked `config.example.json`; copying that fixture fixed staging before any service cutover.
- All 16 release hashes match. Both installed `qq-chat` and `qq-chat-v2` presets match their repository copies.
- `deepseek-harness.service` and `qq-bridge.service` were stopped/started through systemd. Both are active and running, with zero automatic restarts. Authenticated health reports `reserved2`, backend `dsh`, `dshReady: true`, and not paused.
- Existing conversation session IDs, configuration, mode, and role were verified preserved. No state/session files were overwritten. Persistent chat state was backed up after the bridge's graceful shutdown.
- Startup journals had zero matching import, syntax, reference, or unhandled runtime errors.
- A dry run of deployed modules with the live configuration and role/sticker/slang stores confirmed reuse is enabled: the first prepared message was 4,091 characters and the repeated message 87 characters, with unchanged sections omitted. It did not call the model or send to QQ; these are prepared-payload measurements, not model token savings.
- No natural post-deployment prompt appeared during the observation window. Updated persona headers, real chat behavior after compaction, and live token savings remain to be checked under normal traffic. No test QQ messages or model requests were forced.

[Sanitized verification](deployment-session-context-verification.json) contains the exact service state, hash-verification result, dry-run result, and natural-traffic observation.

Remote deployment directory:

`/home/ubuntu/QQ/qq-bridge/state/deployments/20261109-session-context/`

It contains `changed-manifest.json`, the staged release, staged-test logs, `verification.json`, runtime smoke/observation records, and `backup/`. `backup-inventory.json` identifies replaced files. `deploy-remote.py` performed guarded installation and was prepared to restore the backed-up implementation/presets and restart services if verification failed; rollback was not needed. Chat state is never restored from an old snapshot during implementation rollback.

The feature retains `tokenOptimization.reuseSessionContext: false` as a configuration rollback switch. Stable context also refreshes after changes/compaction, a bridge restart/new session/token rotation, or every 16 accepted prompts. DSH continues to submit its system prompt and retained history to the model; this change stops repeated copies being appended by the bridge.
