# Deployment: compact wake payloads

Deployed over SSH on **2026-11-10 at 01:43 UTC** (2026-11-09, 19:43 America/Chicago). This supersedes the earlier blocked attempt and the local-only status in `WAKE-PAYLOAD.md`, round 6 of `TOKEN-USAGE.md`, and `SESSION-CONTEXT-REUSE.md`.

- Fresh authenticated preflight confirmed the running DSH route was ready. All eight changed implementation/preset/test files matched the pre-change source baseline. The live token-usage note lacked rounds 5–6; the candidate only added those sections. Guards checked all inspected source and preset hashes again before staging and cutover.
- The fresh 12-file bundle passed transfer and release SHA-256 checks. Staged server checks passed on Node v24.19.0: token optimization, session-context lifecycle, module integration, Markdown, slang, and all source syntax checks.
- A separate staged-module dry run with the live configuration and role/sticker/slang stores verified compact wakes, omission of unchanged sections, token rotation, and context recovery before cutover.
- Both services were stopped and started through systemd, with backups of replaced source/presets and a consistent state snapshot. No configuration or chat-state file was overwritten, reset, or restored.
- All 12 deployed release hashes match. Both installed DSH presets match their repository copies. Both services are active/running with zero automatic restarts. Authenticated health reports `reserved2`, backend `dsh`, `dshReady: true`, and not paused.
- Existing conversation session mappings, configuration, mode, and role were verified preserved. No rollback was required.
- The deployed-module dry run passed the same checks using live stores: first payload 4,347 characters, routine wake 122 characters. These isolated payloads use a synthetic message and token; they neither invoke the model nor send QQ messages, and they do not measure billed tokens.
- Startup/post-cutover journals contained zero matching import, syntax, reference, type, or unhandled runtime errors. No test QQ message or model request was forced. Live token savings and response quality under normal traffic remain unmeasured.

[Sanitized verification](deployment-wake-payload-verification.json) records service state, authenticated health, file/preset verification, staged/deployed dry-run results, and journal checks.

Remote deployment directory:

`/home/ubuntu/QQ/qq-bridge/state/deployments/20261110-wake-payload/`

It contains the release archive, manifests, fresh preflight, staged candidate and test log, guarded deployment script, dry-run records, `verification.json`, `postcheck.json`, and `backup/`. `backup-inventory.json` identifies replaced files. The deployment script was prepared to restore implementation/preset backups and restart services on verification failure; old chat state is never restored as part of implementation rollback.

Local transfer and verification artifacts are in `.state/deploy-wake-payload-20261110/`. `prepared-verification.json` retains the historical blocked attempt; the current successful result is `verification.json` and the linked sanitized record.
