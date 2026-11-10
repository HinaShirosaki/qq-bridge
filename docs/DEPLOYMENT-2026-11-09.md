# Token optimization deployment

Deployed over SSH on 2026-11-09 at 03:09 UTC. This supersedes the pre-deployment status in `TOKEN-USAGE.md`.

- 71 release files were verified by SHA-256 after installation.
- Installed DSH preset matches the reviewed repository preset.
- Both `deepseek-harness.service` and `qq-bridge.service` are active under systemd, with zero automatic restarts after the successful cutover.
- Authenticated bridge health reports `reserved2`, backend `dsh`, and `dshReady: true`.
- Existing configuration, mode, and conversation session IDs were preserved.
- Staged tests ran on the server against its installed dependencies: token optimization, module integration, Markdown handling, and slang learning. All passed.
- No test messages were sent to QQ, and no new model request was forced for verification. Live token savings and compaction behavior await normal chat activity.

The first cutover detected an automatically restarted bridge instance and rolled back. The successful cutover used systemd to manage both services and removed the temporary unmanaged DSH process.

Remote backups and deployment metadata:

`/home/ubuntu/QQ/qq-bridge/state/deployments/20261109-token-optimized/`

Original backups are in `backup/`; the successful cutover's backup is `backup-attempt2/`. `manifest.json`, `result.json`, and `verification.json` record deployed hashes and service checks. Session logs and persistent memories were not reset or archived.
