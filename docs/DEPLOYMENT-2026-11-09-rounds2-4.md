# Deployment: token optimization rounds 2–4

Deployed over SSH on 2026-11-09 at 04:15:58 UTC, on top of the round-1 deployment (`DEPLOYMENT-2026-11-09.md`).

- Pre-check: all 71 round-1 release files on the server matched the round-1 manifest (no drift); the installed preset matched it too.
- 17 changed files (listed in `release.sha256` below). Staged copy on the server with its installed dependencies: `test-token-optimization`, `test-modules`, `test-md-to-plain`, `test-slang-learn` passed; `node --check` on the bridge, mux and both MCP servers passed.
- After install, every file matched its SHA-256 and `~/.dsh/.agent-presets/qq-chat-v2/` matched the repository preset.
- `deepseek-harness.service` was restarted, then `qq-bridge.service`. Both active, zero automatic restarts. Authenticated `/api/status`: `reserved2`, backend `dsh`, `dshReady: true`, not paused. No errors in either journal after startup.
- Config, mode, role, session IDs, session logs and memories were not changed. No test messages were sent and no model request was forced.

Remote directory: `/home/ubuntu/QQ/qq-bridge/state/deployments/20261109-rounds2-4/`

- `backup/live-files.tgz` and `backup/preset/`: the replaced files.
- `rollback.sh`: restores them and restarts both services.
- `release.tgz`, `release.sha256`, `changed.list`, `cutover-utc`, staged test logs.

Release hashes:

```
51b06dcb168881bfbcea8e573af168e0a2b6d5965cd84528c553939d0bb223df  docs/TOKEN-USAGE.md
40502ace7a82c83994d088e2c66fc005934e166fa6be46827daffd458ad49e9f  dsh/agent-presets/qq-chat-v2/agent.cordis.yml
fd4ac813bc2d70d04add7bf4ebac3f0f1e0a4ec45285d95b2104fef8681ae397  dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs
94ae868fde957f4a2ae45d2a99fcef8f8a946da76178581df53d137c384e780c  scripts/test-token-optimization.mjs
baaebbe00ebbf8673e120767b5be50114d5c0b338eb46a66e37c7b689b82e576  src/bridge/config.js
b388cb09b07c7da08356c674ea55d53ff84e180259db9cfa3af01ad65ebbb14a  src/bridge/startup.js
837088fcc8a3b3b03c779cef2f5342e687bc2fb981099ec7ef60b4856d47ecf9  src/console/wake-config.js
2d236d6a59c21c6d7e9815e9f3c6e666d83d8c8f18db3e727876f02d9198a796  src/events/mux.js
e2c9f7a717d2a8d9a3297ff7ffc25c0f7909f661c5b75660ce1a8e32a390c910  src/mcp/chat-tools.js
e93a9536d378a9a06f35caae24e42a095a66b83a8a21a83cd6233b214208caf1  src/mcp/social-tools.js
1b0d11910ededf5c243570a951b8e73f96310faecafe6fe65f2f5aa854e28b28  src/mcp-web-search-safe.js
fabbd762a698e56d86def3a41e6b3b8a8cd2f15d45f5b5da9effd5bac6c73cca  src/messaging/delivery.js
f10bb3ec5230304554a55478419e40d33d73b6952e191d0ee617d8e8be0d9cca  src/safe-fetch.js
1fb45d70aa4fbb7ac4a93a68ffdaaa2bc584a4fb1b57b6a21b652bec6ddc7547  src/slang/learning.js
19270ae90fafaa03aaedce8caa45f292d75b2552cc709cb6f8a04dccdc9d8f0f  src/social/state.js
fd8ab56fd035a0570d5086d5368c9c28e1b43be601861c2d518e44381de9747b  src/social/wake-timers.js
633850984dc8948aa81b23119ee960c58cb8f9060461d57c9527feca7a77fce1  src/social/wake-triggers.js
```
