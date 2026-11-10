import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const root = process.cwd();
async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qq-split-"));
  const cfg = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
  cfg.consoleToken = "isolated-test-console-token";
  cfg.consolePort = 3100;
  cfg.replyBackend = "dsh";
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(cfg));
  fs.mkdirSync(path.join(tmp, "roles"));
  let handler;
  const errors = [];
  const timers = [];
  const remap = (p) => (typeof p === "string" && p.startsWith(root) ? tmp + p.slice(root.length) : p);
  const fakeFs = new Proxy(fs, {
    get(t, k) {
      if (k === "default") return fakeFs;
      const v = t[k];
      if (typeof v !== "function") return v;
      return (...args) => {
        if (args.length) args[0] = remap(args[0]);
        if (["renameSync", "copyFileSync"].includes(k)) args[1] = remap(args[1]);
        return v(...args);
      };
    },
  });
  class Bot {
    constructor() {}
    onPrivateMessage() {}
    onGroupMessage() {}
    onNotice() {}
    on() {}
    async connect() {}
    async getLoginInfo() {
      return { nickname: "Test" };
    }
  }
  const api = {
    workspace: { list: async () => ({ items: [] }) },
    settings: { get: async () => ({}) },
    events: {
      mux: async function* () {
        await new Promise(() => {});
      },
    },
    session: {},
    runtime: {},
  };
  const globals = {
    console: { log() {}, error: (...x) => errors.push(x.join(" ")), warn() {} },
    Buffer,
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async () => {
      throw Error("network disabled");
    },
    setTimeout: (f, ms) => {
      timers.push(f);
      return timers.length;
    },
    clearTimeout() {},
    setInterval: (f, ms) => {
      timers.push(f);
      return timers.length;
    },
    clearInterval() {},
    process: {
      pid: process.pid,
      platform: process.platform,
      env: {},
      on() {},
      kill() {
        throw Error("no process");
      },
      exit(code) {
        throw Error("exit " + code);
      },
    },
  };
  const context = vm.createContext(globals);
  const cache = new Map();
  function synthetic(id, obj) {
    const names = [...new Set(["default", ...Object.keys(obj)])];
    return new vm.SyntheticModule(
      names,
      function () {
        for (const n of names) this.setExport(n, n === "default" ? obj : obj[n]);
      },
      { context, identifier: id },
    );
  }
  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    let m;
    if (id === "node:fs") m = synthetic(id, fakeFs);
    else if (id === "node:http")
      m = synthetic(id, {
        createServer(h) {
          handler = h;
          return {
            listen(p, h, cb) {
              cb?.();
            },
            on() {},
            close() {},
          };
        },
      });
    else if (id.startsWith("node:")) m = synthetic(id, await import(id));
    else if (id === "@snowluma/sdk")
      m = synthetic(id, { SnowLumaWebSocketClient: Bot, text: (t) => ({ type: "text", data: { text: t } }) });
    else if (id.endsWith("/dsh-client.js"))
      m = synthetic(id, {
        NodeApiClient: class {
          constructor() {
            return api;
          }
        },
        unwrap: (v) => v,
        createTurnCollector: () => ({}),
      });
    else {
      let code = fs.readFileSync(id, "utf8");
      m = new vm.SourceTextModule(code, {
        context,
        identifier: id,
        initializeImportMeta(meta) {
          meta.url = "file://" + id;
        },
      });
    }
    cache.set(id, m);
    return m;
  }
  try {
    const entry = await load(path.join(root, "src/bridge.js"));
    await entry.link(async (spec, parent) =>
      load(spec.startsWith(".") ? path.resolve(path.dirname(parent.identifier), spec) : spec),
    );
    await entry.evaluate();
    for (let i = 0; i < 40 && !handler; i++) await new Promise((r) => setImmediate(r));
    assert.ok(handler, "console server started: " + errors);
    return {
      async moduleExports(file) {
        return (await load(path.join(root, file))).namespace;
      },
      async request(url, method = "GET", body, token = cfg.consoleToken) {
        let response;
        const req = {
          url,
          method,
          headers: { "x-console-token": token, "content-type": "application/json" },
          on(event, fn) {
            if (event === "data" && body) fn(Buffer.from(JSON.stringify(body)));
            if (event === "end") fn();
          },
          pause() {},
        };
        const res = {
          writeHead(status, headers) {
            response = { status, headers };
          },
          end(data) {
            response.body = data;
          },
        };
        await handler(req, res);
        return response;
      },
      cleanup() {
        fs.rmSync(tmp, { recursive: true, force: true });
      },
      errors,
    };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
const bridge = await boot();
try {
  for (const route of [
    "/api/status",
    "/api/roles",
    "/api/slang",
    "/api/sessions",
    "/api/pending",
    "/api/whitelist",
    "/api/security",
    "/api/social",
    "/api/socialV2/config",
    "/api/socialV2/states",
    "/api/socialV2/activity",
    "/api/socialV2/feedback",
    "/api/socialV2/tool-log",
    "/api/stickers",
  ]) {
    const response = await bridge.request(route);
    assert.equal(response.status, 200, route);
    assert.doesNotThrow(() => JSON.parse(response.body), route);
  }
  assert.equal((await bridge.request("/no-such-route")).status, 404);
  assert.equal((await bridge.request("/api/status", "GET", undefined, "wrong")).status, 401);
  assert.equal((await bridge.request("/api/mode", "POST", { mode: "invalid" })).status, 400);
  assert.equal((await bridge.request("/api/role-mode", "POST", { mode: "silent" })).status, 200);
  assert.equal((await bridge.request("/api/mode", "POST", { mode: "reserved2" })).status, 200);
  assert.equal(JSON.parse((await bridge.request("/api/status")).body).mode, "reserved2");
  assert.equal((await bridge.request("/api/session/reset", "POST", { key: "group:123" })).status, 404);
  for (const [file, name, route, body] of [
    [
      "src/console/send-messages.js",
      "handleMessageSendRoutes",
      "/api/socialV2/send-burst",
      { key: "group:123", messages: ["hello"] },
    ],
    [
      "src/console/send-and-reset.js",
      "handleSendAndResetRoutes",
      "/api/send/group",
      { groupId: "123", message: "hello", token: "agent" },
    ],
  ]) {
    const state = { sendTimes: [], wakeConfig: {} };
    let saved = 0;
    let response;
    const context = {
      cfg: { socialV2: { send: {} } },
      currentMode: "reserved2",
      socialV2: { paused: false },
      modeAllowed: () => true,
      shouldBlockSilentReply: () => false,
      getSocialV2State: () => state,
      computeGapsV2: () => [],
      unquoteJsonString: (value) => value,
      sendMessagesV2: async () => {
        throw Error("simulated send failure");
      },
      saveSocialV2State: () => saved++,
    };
    const env = {
      req: { method: "POST", headers: { "x-agent-token": "agent" } },
      url: new URL(route, "http://localhost"),
      readBody: async () => body,
      agentTokenOk: () => true,
      v2SessionAllowed: () => true,
      v2ToolEnabled: () => true,
      sendJson: (body, status) => {
        response = { body, status };
      },
    };
    const exports = await bridge.moduleExports(file);
    assert.equal(await exports[name](context, env), true);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "simulated send failure");
    assert.equal(state.sendTimes.length, 0, "failed sends release reserved quota");
    assert.equal(saved, 1);
  }
  const replacementToken = "rotated-isolated-console-token";
  assert.equal((await bridge.request("/api/console/token", "POST", { token: replacementToken })).status, 200);
  assert.equal((await bridge.request("/api/status")).status, 401, "old token is revoked");
  assert.equal((await bridge.request("/api/status", "GET", undefined, replacementToken)).status, 200);
  assert.deepEqual(bridge.errors, []);
  // Exercise the real mux + wrapper with no network/model/QQ sends.
  const contextFns = await bridge.moduleExports('src/messaging/context.js');
  const slangFns = await bridge.moduleExports('src/slang/learning.js');
  const muxFns = await bridge.moduleExports('src/events/mux.js');
  const reused = {
    cfg: { replyBackend: 'dsh', socialV2: { sticker: { enabled: false } } }, currentMode: 'reserved2',
    readRoleState: () => ({ role: 'Test' }), currentRoleHintV2: () => 'retained-role-card',
    getSocialV2State: () => ({ agentToken: 'test-token' }), slangEntries: [], stickerEntries: [],
    formatMemoryV2: () => '',
    reverse: new Map([['test-session', 'group:123']]), api: {}, collectors: new Map(),
  };
  reused.withSlangContext = (...args) => slangFns.withSlangContext(reused, ...args);
  const seeded = contextFns.prepareSessionPrompt(reused, 'group:123', 'test-session', 'new message');
  seeded.commit();
  assert.ok(!contextFns.prepareSessionPrompt(reused, 'group:123', 'test-session', 'another').text.includes('retained-role-card'));
  await muxFns.handleMuxEnvelope(reused, { payload: { type: 'session/event', sessionId: 'test-session', event: { type: 'compaction/end' } } });
  assert.ok(contextFns.prepareSessionPrompt(reused, 'group:123', 'test-session', 'after compact').text.includes('retained-role-card'));
  assert.equal(reused.collectors.size, 0, 'compaction outside a turn does not leave a busy collector');
  reused.slangEntries = [{ status: 'confirmed', content: 'test-slang', meaning: 'meaning', count: 1 }];
  assert.ok(slangFns.withSlangContext(reused, 'message').includes('test-slang'));
  assert.ok(!slangFns.withSlangContext(reused, 'message', { includeSlang: false }).includes('test-slang'));
  const compact = slangFns.withSlangContext(reused, '【唤醒】group:123', { includeSlang: false, compactTime: true });
  assert.match(compact, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\n]+\n【唤醒】group:123$/);
  assert.ok(!compact.includes('【当前时间】'));
  console.log('PASS real compaction mux invalidation and nonduplicating slang wrapper');
  console.log("PASS isolated startup, console routes, authentication, mutable mode, missing-session reset");
} finally {
  bridge.cleanup();
}

// Keep feature modules within the requested size range; entrypoints can be smaller.
for (const directory of ["bridge", "console", "events", "social", "messaging", "media", "stickers", "slang", "mcp"]) {
  for (const name of fs.readdirSync(path.join(root, "src", directory)).filter((name) => name.endsWith(".js"))) {
    const file = path.join(root, "src", directory, name);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").length;
    assert.ok(lines >= 200 && lines <= 500, `${file}: ${lines} lines`);
  }
}
const { registerChatTools } = await import("../src/mcp/chat-tools.js");
const { registerSocialTools } = await import("../src/mcp/social-tools.js");
const { registerSnowLumaMediaTools } = await import("../src/mcp/media-tools.js");
const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema });
const names = [];
const dependencies = { server: { tool: (name) => names.push(name) }, z: schema, cfg: {} };
for (const register of [registerChatTools, registerSocialTools, registerSnowLumaMediaTools]) register(dependencies);
assert.equal(names.length, 36);
assert.equal(new Set(names).size, 36);
console.log("PASS module sizes and all 36 unique MCP registrations");
