// Intercept the existing DSH prompt contract while retaining the QQ event pipeline.
//
// 【本地补丁】加入可用性探测与 DSH 回退：
// 原实现 replyBackend 是**静态开关** —— 一旦配成 local-codex，所有 prompt 都发给 codex，
// 失败时只把错误写进 turn/end（注释原文 "No DSH fallback was used"），
// 于是 codex 不可用（反向 SSH 隧道断了 / Mac 休眠）时 QQ 侧完全没有回复。
// 现在：先探活（TCP 连本地反向转发端口，结果缓存 15s），不可用就直接走 DSH；
// 探活过了但请求失败（隧道在探活间隙断掉）也会立刻标记不可用并回退到 DSH。
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE_TIMEOUT_MS = 600;
const PROBE_CACHE_MS = 15000;

/** 读取 codex 反向隧道端口；读不到返回 null。 */
function readCodexPort(explicit) {
  if (explicit) return explicit;
  try {
    const cfgPath = path.join(os.homedir(), 'codex-bridge', 'server-config.json');
    const port = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).port;
    return Number.isFinite(Number(port)) ? Number(port) : null;
  } catch {
    return null;
  }
}

/** TCP 探活：能连上本地反向转发端口就算"可用"。 */
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function createCodexReplyRouter(api, {
  backend = 'dsh', getContext = () => ({}), emit, log = () => {}, request,
  clientModule = path.join(os.homedir(), 'codex-bridge/request.mjs'),
  codexPort,
  probeCacheMs = PROBE_CACHE_MS,
} = {}) {
  if (backend === 'dsh') return api;
  if (backend !== 'local-codex') throw new Error('replyBackend must be dsh or local-codex');

  // 回退目标：原始 DSH 客户端（绑到原对象，避免和下面的 Proxy 递归）。
  const dshSessions = api.sessions;
  const dshPrompt = dshSessions.prompt.bind(dshSessions);

  const chains = new Map();
  const history = new Map();
  const codexOwned = new Set(); // sessionId：本回合由 codex 接管（决定 mux 事件是否过滤）
  const stats = {
    backend, submitted: 0, completed: 0, failed: 0, fallback: 0, active: 0,
    codexAvailable: null, lastProbeAt: 0,
  };

  // 【本地对账】端口不能在启动时固化成常量：Mac 侧重建反向隧道时端口会变
  // （实测从 18766 变成 18767），固化的话桥接会一直探测旧端口、永远判定 codex 不可用。
  // 未显式指定端口时每 30 秒重读一次 server-config.json。
  let resolvedPort = readCodexPort(codexPort);
  let resolvedPortAt = Date.now();
  function currentPort() {
    if (codexPort) return codexPort;
    if (Date.now() - resolvedPortAt > 30000) {
      const next = readCodexPort(null);
      resolvedPortAt = Date.now();
      if (next !== resolvedPort) {
        log(`[reply-route] codex 端口变更 ${resolvedPort ?? 'null'} -> ${next ?? 'null'}`);
        resolvedPort = next;
        stats.codexAvailable = null; // 端口变了要重新探活
      }
    }
    return resolvedPort;
  }
  const invoke = request ?? (async (prompt, options) => {
    const client = await import(pathToFileURL(clientModule).href);
    return client.request(prompt, options);
  });

  /** 探活（带缓存）。没有配置端口时永不尝试 codex。 */
  async function codexAvailable() {
    if (Date.now() < codexDownUntil) return false;
    const port = currentPort();
    if (port === null) return false;
    const now = Date.now();
    if (stats.codexAvailable !== null && now - stats.lastProbeAt < probeCacheMs) {
      return stats.codexAvailable;
    }
    const ok = await probePort(port);
    stats.codexAvailable = ok;
    stats.lastProbeAt = now;
    return ok;
  }

  // codex 失败后的退避窗口：期间直接走 DSH，避免每条消息都白等一次超时
  let codexDownUntil = 0;
  let lastFallbackLogAt = 0;
  /** 标记 codex 暂不可用（默认退避 60 秒），并清掉可用性缓存。 */
  function markUnavailable(reason, backoffMs = 60000) {
    codexDownUntil = Date.now() + backoffMs;
    stats.codexAvailable = false;
    stats.lastProbeAt = Date.now();
    // 只留一行运维日志，不把 codex 的原始错误抛给用户
    log(`[reply-route] codex 暂不可用，${Math.round(backoffMs / 1000)}s 内改走 DSH`);
  }

  async function run(params, context) {
    const sessionId = params.sessionId;
    const stillCurrent = () => !context.key ||
      (getContext(sessionId)?.key === context.key && getContext(sessionId)?.epoch === context.epoch);

    // ── 探活：不可用就直接把这次 prompt 交给 DSH，并透传 DSH 的结果 ──
    if (!(await codexAvailable())) {
      stats.fallback++;
      // 日志限流：codex 长期关闭时不要每条消息都刷一行（5 分钟一次足够定位问题）
      const now = Date.now();
      if (now - lastFallbackLogAt > 300000) {
        lastFallbackLogAt = now;
        log(`[reply-route] codex 不可用，改走 DSH（累计 ${stats.fallback} 次）`);
      }
      // 走 DSH 时必须放开 mux 事件过滤，否则桥接收不到 turn/end
      codexOwned.delete(sessionId);
      return dshPrompt(params);
    }

    const turn = crypto.randomUUID();
    const event = (type, data) => emit({ localCodex: true,
      payload: { type: 'session/event', sessionId, event: { type, data } } });
    codexOwned.add(sessionId);
    stats.active++;
    try {
      await event('turn/start', { turn });
      const prompt = (params.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n\n');
      const images = (params.content ?? []).filter(p => p.type === 'image')
        .map(p => ({ mediaType: p.mediaType, data: p.data }));
      const previous = history.get(sessionId) ?? [];
      const profile = context.mode === 'reserved2' && context.key ? 'qq' :
        context.learner ? 'research' : 'text';
      const wirePrompt = profile === 'qq' ? prompt.replace(/【会话令牌】[^\n]*/g,
        '【会话权限】工具已绑定当前会话，令牌由桥接自动注入。') : prompt;
      log(`[local-codex] request ${turn} (${context.key || 'background'}) profile=${profile}`);
      const answer = await invoke(wirePrompt || 'Use the attached images.', {
        profile, images, timeoutMs: profile === 'qq' ? 1830000 : 330000,
        instructions: context.roleHint || '',
        context: { history: previous, mode: context.mode, conversationKey: context.key },
      });
      if (!stillCurrent()) return;
      const next = [...previous, { role: 'user', content: wirePrompt }, { role: 'assistant', content: answer }];
      while (next.length > 12 || (next.length > 2 && JSON.stringify(next).length > 32000)) next.splice(0, 2);
      history.delete(sessionId);
      history.set(sessionId, next);
      if (history.size > 100) history.delete(history.keys().next().value);
      if (answer) await event('assistant/message', { turn,
        message: { content: [{ type: 'text', text: answer }] } });
      await event('turn/end', { turn, reason: { kind: 'completed' } });
      stats.completed++;
      log(`[local-codex] completed ${turn} (${context.key || 'background'})`);
    } catch (error) {
      stats.failed++;
      // 不论 failure 是什么（隧道断、HTTP 502、超时…），一律静默降级到 DSH：
      // 用户不该看到 codex 的任何报错，机器人也不该因为 codex 挂了而不说话。
      markUnavailable(String(error?.message ?? error));
      codexOwned.delete(sessionId);
      try {
        // 收尾这次 codex turn（用 aborted 而不是 error，避免把错误抛到会话/UI）
        await event('turn/end', { turn, reason: { kind: 'aborted' } });
      } catch {}
      if (!stillCurrent()) return;
      stats.fallback++;
      log(`[reply-route] 改走 DSH（${context.key || 'background'}）`);
      return dshPrompt(params);
    } finally {
      stats.active--;
      codexOwned.delete(sessionId);
    }
  }

  const sessions = new Proxy(dshSessions, {
    get(target, prop) {
      if (prop !== 'prompt') {
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async params => {
        const context = { ...getContext(params.sessionId) };
        stats.submitted++;
        const prior = chains.get(params.sessionId) ?? Promise.resolve();
        const job = prior.catch(() => {}).then(() => run(params, context));
        chains.set(params.sessionId, job);
        job.finally(() => {
          if (chains.get(params.sessionId) === job) chains.delete(params.sessionId);
        }).catch(error => log(`[local-codex] dispatch error: ${error.message}`));
        // codex 接管时是"发出即返回"（结果通过 emit 事件回放）；
        // 回退 DSH 时 run() 会返回 DSH 的真实结果，必须透传，否则 bridge 拿不到 accepted。
        let settled;
        try {
          settled = await job;
        } catch {
          settled = null;
        }
        if (settled && settled.result) return settled;
        return { result: { ok: true, value: {} } };
      };
    },
  });

  return new Proxy(api, {
    get(target, prop) {
      if (prop === 'sessions') return sessions;
      if (prop === 'replyRouteStatus') return () => ({
        ...stats, codexPort: currentPort(), owns: codexOwned.size,
      });
      if (prop === 'replyRouteIdle') return () => Promise.all([...chains.values()]);
      // 桥接用它决定是否过滤 DSH 的 mux 事件：只有"这一回合真的由 codex 接管"时才过滤。
      if (prop === 'replyRouteOwns') return (sessionId) => codexOwned.has(sessionId);
      if (prop === 'replyRouteProbe') return () => codexAvailable();
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
