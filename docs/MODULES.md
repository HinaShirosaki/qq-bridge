# Source organization

`node src/bridge.js` remains the bridge entry point. `src/mcp-snowluma-safe.js` remains the stdio MCP entry point, so launch commands and DSH presets keep working.

The extracted feature modules contain 200–500 lines each. `npm run test-modules` checks this range and exercises startup and console requests with simulated transports and temporary storage. It never connects to QQ or DSH.

| Folder | Responsibility |
| --- | --- |
| `src/bridge/` | Configuration, persistence, logging, sessions, and startup |
| `src/console/` | HTTP authentication, request handling, and routes grouped by feature |
| `src/messaging/` | Incoming messages, replies, approvals, prompts, and quoted-message lookup |
| `src/social/` | Conversation history, persistent state, wake triggers, and timers |
| `src/events/` | DSH event stream processing and reconnection |
| `src/media/` | Image identification, validation, fetching, and resolution |
| `src/stickers/` | Sticker synchronization and sending |
| `src/slang/` | Slang extraction, research, and learner sessions |
| `src/mcp/` | Chat, social, and media tool registration |

The entry point creates one `bridgeContext` per bridge process. Feature functions receive that context explicitly. Mutable fields such as the current mode, session generation, queues, caches, and timers live on this shared object, so asynchronous operations see current state. Startup initializes fields in the original order. Importing feature modules does not start connections.

Console handlers also receive a request adapter, `env`, containing the request, response helpers, and authorization checks. Its console-token accessor updates the server's live token when the token-rotation route runs. A handler returns `true` when it handles a request and `false` to continue dispatch. Authentication and CSRF checks run before dispatch.

The refactor also fixes two existing send-failure handlers whose quota rollback used variables outside their scope. Tests simulate send failures and check that reserved quota is released.

Validation distinguishes isolated transport tests from a real server smoke test. Running `npm run test-modules` does not establish live QQ/DSH compatibility or deploy these files.
