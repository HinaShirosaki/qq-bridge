# Notice

This is a modified fork of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge),
based on upstream commit `24fcb8b` (2026-09-14). All credit for the original project goes to its author.

Changes add a local Codex reply backend with DSH fallback (`src/codex-reply-router.js`),
scoped per-conversation MCP access, token/session-context optimizations, and wake-payload
changes; see `docs/` for details. Later upstream versions are licensed under the
PolyForm Noncommercial License 1.0.0; use this fork accordingly.
