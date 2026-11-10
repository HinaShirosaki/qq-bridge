import fs from 'node:fs';

import path from 'node:path';

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { NodeApiClient } from "../dsh-client.js";
import { createCodexReplyRouter } from "../codex-reply-router.js";

import { loadConfig as loadBridgeConfig } from "./config.js";

import { loadSlang } from "../slang-learner.js";
import { loadStickerStore } from "../sticker-lib.js";

export async function initialize1(bridgeContext) {
bridgeContext.__dirname = path.dirname(fileURLToPath(import.meta.url));
bridgeContext.ROOT = path.resolve(bridgeContext.__dirname, '..', '..');
bridgeContext.STATE_DIR = path.join(bridgeContext.ROOT, 'state');
bridgeContext.STATE_FILE = path.join(bridgeContext.STATE_DIR, 'sessions.json');
bridgeContext.ROLE_STATE_FILE = path.join(bridgeContext.STATE_DIR, 'current-role.json');
bridgeContext.SLANG_FILE = path.join(bridgeContext.STATE_DIR, 'slang.json');
bridgeContext.SLANG_SESSION_FILE = path.join(bridgeContext.STATE_DIR, 'slang-session.json');
bridgeContext.SOCIAL_V2_FILE = path.join(bridgeContext.STATE_DIR, 'social-v2.json');
bridgeContext.STICKER_FILE = path.join(bridgeContext.STATE_DIR, 'stickers.json');
bridgeContext.FEEDBACK_FILE = path.join(bridgeContext.STATE_DIR, 'feedback.json');
bridgeContext.TOOL_LOG_FILE = path.join(bridgeContext.STATE_DIR, 'tool-calls.jsonl');
bridgeContext.ACTIVITY_LOG = path.join(bridgeContext.STATE_DIR, 'qq-activity.log');
bridgeContext.BRIDGE_LOG = path.join(bridgeContext.STATE_DIR, 'bridge.log');
bridgeContext.SILENT_MARKER = '[SILENT]';
bridgeContext.CODEX_NOISE_RE = /codex|Codex 桥接|Codex bridge|local-codex/i;
bridgeContext.SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
bridgeContext.SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
bridgeContext.DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';
bridgeContext.KNOWN_AGENT_TOKENS = new Set();
bridgeContext.state = { sessions: {} };
bridgeContext.LOCK_FILE = path.join(bridgeContext.STATE_DIR, 'bridge.lock');
bridgeContext.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
bridgeContext.convKey = (kind, id) => `${kind}:${id}`;
bridgeContext.SEND_TIMEOUT_MS = 15000;
bridgeContext.APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
bridgeContext.REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);
process.on('SIGINT', () => {
  bridgeContext.log('退出中…');
  bridgeContext.saveState();
  bridgeContext.releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  bridgeContext.saveState();
  bridgeContext.releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => bridgeContext.log('未处理异常:', error?.message ?? error));
process.on('exit', () => bridgeContext.releaseLock());
bridgeContext.cfg = loadBridgeConfig(bridgeContext.ROOT, bridgeContext.readJsonSafe);
fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
bridgeContext.acquireLock();
bridgeContext.loadState();
bridgeContext.slangEntries = loadSlang(bridgeContext.SLANG_FILE);
bridgeContext.slangWindows = new Map();
bridgeContext.slangExtractionCooldowns = new Map();
bridgeContext.slangSubmitTimes = new Map();
bridgeContext.feedbackTimes = new Map();
bridgeContext.slangResearchingIds = new Set();
bridgeContext.learnerSessions = new Set();
bridgeContext.learnerCollectors = new Map();
bridgeContext.learnerWaiters = new Map();
bridgeContext.slangLearnerSessionId = null;
bridgeContext.slangTaskChain = Promise.resolve();
bridgeContext.stickerEntries = loadStickerStore(bridgeContext.STICKER_FILE);
bridgeContext.stickerSyncedAt = 0;
bridgeContext.lastForcedAgentStickerSync = 0;
if (!bridgeContext.cfg.allow.private.length && !bridgeContext.cfg.allow.groups.length && bridgeContext.cfg.allowAllWhenEmpty) {
    bridgeContext.log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  }
bridgeContext.createRouter = createCodexReplyRouter;
if (bridgeContext.cfg.replyBackend === 'local-codex') {
    try {
      const extPath = `file://${path.join(os.homedir(), 'codex-bridge', 'qq-reply-router.mjs')}`;
      const ext = await import(extPath);
      if (typeof ext.createCodexReplyRouter === 'function') {
        bridgeContext.createRouter = ext.createCodexReplyRouter;
        bridgeContext.log('[reply-route] 使用 ~/codex-bridge 的 failover router');
      }
    } catch (error) {
      bridgeContext.log(`[reply-route] 外部 router 不可用，使用内置简化版：${error?.message ?? error}`);
    }
  }
bridgeContext.api = bridgeContext.createRouter(new NodeApiClient(bridgeContext.cfg.dsh.baseUrl), {
    backend: bridgeContext.cfg.replyBackend,
    log: bridgeContext.log,
    emit: bridgeContext.handleMuxEnvelope,
    getContext: (sessionId) => ({
      key: bridgeContext.reverse.get(sessionId), mode: bridgeContext.currentMode, epoch: bridgeContext.sessionEpoch,
      learner: bridgeContext.learnerSessions.has(sessionId),
      roleHint: bridgeContext.currentMode === 'reserved2' ? bridgeContext.currentRoleHintV2() : bridgeContext.currentRoleHint()
    })
  });
bridgeContext.log(`[reply-route] ${bridgeContext.cfg.replyBackend}`);
bridgeContext.collectors = new Map();
bridgeContext.sendToolSucceededSessions = new Set();
bridgeContext.v2TurnStartAt = new Map();
bridgeContext.toolCallNames = new Map();
bridgeContext.pendingSendToolCalls = new Map();
bridgeContext.pendingWakeKeys = new Set();
bridgeContext.activeWaits = new Set();
bridgeContext.activeWaitSince = new Map();
bridgeContext.pendingWakeLeaseTimers = new Map();
bridgeContext.wakeConfigUpdatedKeys = new Set();
bridgeContext.markReadCalledKeys = new Set();
bridgeContext.wakeConfigMissCount = new Map();
bridgeContext.reverse = new Map();
for (const [key, sessionId] of Object.entries(bridgeContext.state.sessions)) bridgeContext.reverse.set(sessionId, key);
bridgeContext.sessionPromises = new Map();
bridgeContext.promptQueues = new Map();
bridgeContext.dshReady = false;
bridgeContext.dshCheckStarted = false;
bridgeContext.currentMode = 'chat';
bridgeContext.lastMode = bridgeContext.currentMode;
bridgeContext.closedAgentPreset = 'router-standard';
bridgeContext.queued = new Map();
bridgeContext.queuedHintAt = new Map();
bridgeContext.QUEUE_MAX = 50;
bridgeContext.QUEUE_HINT_COOLDOWN_MS = 30_000;
bridgeContext.queueRetries = new Map();
bridgeContext.enqueueForRetry = (key, promptText, opts = {}) => {
    const items = bridgeContext.queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= bridgeContext.QUEUE_MAX) {
        items.shift();
        bridgeContext.log(`队列满（${bridgeContext.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      bridgeContext.queued.set(key, items);
    }
    bridgeContext.queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { bridgeContext.flushQueue(); }, 3000);
  };
bridgeContext.VALID_MODES = ['chat', 'closed-agent', 'reserved', 'reserved2'];
bridgeContext.flushingQueue = false;
bridgeContext.flushQueue = async () => {
    if (bridgeContext.flushingQueue) return;
    bridgeContext.flushingQueue = true;
    try {
      const entries = [...bridgeContext.queued.entries()];
      bridgeContext.queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
              bridgeContext.log(`补投跳过未授权会话 ${key}（当前模式 ${bridgeContext.currentMode}）`);
              continue;
            }
            const result = await bridgeContext.deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [] });
            if (!result.ok) {
              bridgeContext.log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = bridgeContext.queued.get(key) ?? [];
              bridgeContext.queued.set(key, rest.concat(existing));
              break;
            }
            bridgeContext.queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            bridgeContext.log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = bridgeContext.queued.get(key) ?? [];
            bridgeContext.queued.set(key, rest.concat(existing));
            break;
          }
        }
        bridgeContext.log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (bridgeContext.queueRetries.get(key) ?? 0) + 1;
          bridgeContext.queueRetries.set(key, retries);
          if (retries > 5) {
            bridgeContext.log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              bridgeContext.queueRetries.delete(key);
              bridgeContext.flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { bridgeContext.flushQueue(); }, delay);
          }
        }
      }
    } finally {
      bridgeContext.flushingQueue = false;
    }
  };
bridgeContext.checkDsh = async () => {
    let ok = false;
    try {
      await bridgeContext.api.host.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await bridgeContext.refreshMode();
      if (!bridgeContext.dshReady) {
        bridgeContext.dshReady = true;
        bridgeContext.lastMode = bridgeContext.currentMode;
        bridgeContext.log(`DSH 已就绪（模式: ${bridgeContext.currentMode}）`);
        if (bridgeContext.currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of bridgeContext.socialV2.conversations.keys()) {
            bridgeContext.setupSleepTimerV2(key);
            bridgeContext.scheduleProactiveCheckV2(key);
          }
          bridgeContext.log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await bridgeContext.flushQueue(); } catch (error) { bridgeContext.log('补投队列异常:', error?.message ?? error); }
        // 【本地补丁】断连期间被记为“会话繁忙”的唤醒原因本来只在 turn/end 时补发，
        // 而 DSH 重启不会有 turn/end，这些 @/关键词就会永久躺在队列里。恢复后主动补发一次。
        for (const [pKey, pSt] of bridgeContext.socialV2.conversations) {
          if (!Array.isArray(pSt?.pendingWakeReasons) || !pSt.pendingWakeReasons.length) continue;
          const best = [...pSt.pendingWakeReasons]
            .filter((r) => r && typeof r === 'object')
            .sort((a, b) => bridgeContext.wakePriorityV2(b.reason) - bridgeContext.wakePriorityV2(a.reason))[0];
          const dropped = pSt.pendingWakeReasons.length;
          pSt.pendingWakeReasons.length = 0;
          bridgeContext.saveSocialV2State();
          if (best) {
            bridgeContext.log(`[reserved2] DSH 恢复，补发暂存唤醒 ${pKey}（${best.reason}，共 ${dropped} 条）`);
            try { bridgeContext.scheduleWakeV2(pKey, best.reason); } catch (error) { bridgeContext.log('补发唤醒失败:', error?.message ?? error); }
          }
        }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...bridgeContext.slangWindows.keys()]) bridgeContext.maybeQueueSlangExtraction(key);
      } else if (bridgeContext.currentMode !== bridgeContext.lastMode) {
        if (bridgeContext.lastMode === 'reserved' && bridgeContext.currentMode !== 'reserved') {
          bridgeContext.cleanupSocialForModeChange();
          bridgeContext.log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (bridgeContext.lastMode === 'reserved2' && bridgeContext.currentMode !== 'reserved2') {
          bridgeContext.clearAllSocialV2Timers();
          bridgeContext.drainAllPromptQueues('模式切换，已取消排队中的投递');
          bridgeContext.log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (bridgeContext.currentMode === 'reserved2' && bridgeContext.lastMode !== 'reserved2') {
          for (const key of bridgeContext.socialV2.conversations.keys()) {
            bridgeContext.setupSleepTimerV2(key);
            bridgeContext.scheduleProactiveCheckV2(key);
          }
          bridgeContext.log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        bridgeContext.log(`桥接模式已切换为: ${bridgeContext.currentMode}`);
        bridgeContext.lastMode = bridgeContext.currentMode;
      }
    } else if (bridgeContext.dshReady) {
      bridgeContext.dshReady = false;
      bridgeContext.log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
      // 【本地补丁】DSH 重启会掐断 events.mux 事件流，导致在途 turn 的 turn/end **永远收不到**：
      //   - collectors / v2TurnStartAt 只在 turn/end 里删除 → 永久残留
      //   - deliverPromptNow 在等 turn 结果且没有超时 → promptQueues 里 running 永久为 true
      // 三者任一残留都会让 isConversationBusyV2() 恒为 true，此后所有 @/唤醒只会被记为
      // “会话繁忙”而入队，再也不会被处理（实测 18:25 DSH 重启后 @ 完全无响应）。
      // DSH 一旦掉线，就作废这些"在途"状态；恢复后由下面的补发逻辑重新唤醒。
      const staleCollectors = bridgeContext.collectors.size;
      const staleTurns = bridgeContext.v2TurnStartAt.size;
      bridgeContext.collectors.clear();
      bridgeContext.v2TurnStartAt.clear();
      bridgeContext.pendingWakeKeys.clear();
      bridgeContext.drainAllPromptQueues('DSH 不可用，取消在途投递');
      if (staleCollectors || staleTurns) {
        bridgeContext.log(`已清理 DSH 断连残留：collectors=${staleCollectors} turns=${staleTurns}`);
      }
    }
  };
bridgeContext.ADAPTIVE_WAKE_BUCKETS = [
    { below: 0.5, probability: 0.30 },   // 3 分钟不到 2 条：非常冷清
    { below: 1.5, probability: 0.20 },
    { below: 3.0, probability: 0.12 },
    { below: 6.0, probability: 0.05 },
    { below: 12.0, probability: 0.02 },
    { below: Infinity, probability: 0.01 } // 每分钟 12 条以上：极热闹
  ];
bridgeContext.sessionEpoch = 0;
bridgeContext.pending = new Map();
bridgeContext.sendChain = Promise.resolve();
bridgeContext.MAX_MEDIA_COUNT = 5;
bridgeContext.MAX_MEDIA_BYTES = 4 * 1024 * 1024;
bridgeContext.MAX_MEDIA_PIXELS = 64_000_000;
bridgeContext.MAX_MEDIA_STORE_PER_KEY = 500;
bridgeContext.visionModelAppliedSessions = new Set();
bridgeContext.randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
bridgeContext.selfNickname = 'deepseek';
bridgeContext.SILENT_TURN_TIMEOUT_MS = 300000;
bridgeContext.social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };
bridgeContext.socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };
bridgeContext.messageMediaStore = new Map();
bridgeContext.seenForwardIds = new Map();
bridgeContext.EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;
bridgeContext.loadSocialV2State();
if (bridgeContext.isSocialEnabled() || bridgeContext.cfg.social?.enabled !== false) {
    bridgeContext.startSocialLoop();
  }
bridgeContext.roleHintCache = { key: '', hint: '' };
bridgeContext.groupMemberNameCache = new Map();
bridgeContext.GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
bridgeContext.replyInfoCache = new Map();
bridgeContext.REPLY_INFO_TTL_MS = 10 * 60 * 1000;
bridgeContext.REPLY_NEGATIVE_TTL_MS = 5 * 1000;
bridgeContext.SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
}

export async function initialize2(bridgeContext) {
bridgeContext.WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    preSleepObserve: 45,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };
bridgeContext.bot = new SnowLumaWebSocketClient({
    url: bridgeContext.cfg.snowluma.wsUrl,
    accessToken: bridgeContext.cfg.snowluma.accessToken || undefined,
    reconnect: true
  });
bridgeContext.bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await bridgeContext.handleIncoming('private', event.user_id, event, bridgeContext.cfg); } catch (error) { bridgeContext.log('处理私聊消息出错:', error?.message ?? error); }
  });
bridgeContext.bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await bridgeContext.handleIncoming('group', event.group_id, event, bridgeContext.cfg); } catch (error) { bridgeContext.log('处理群消息出错:', error?.message ?? error); }
  });
bridgeContext.bot.onNotice('notify', async (event) => {
    try { await bridgeContext.handlePokeNotice(event); } catch (error) { bridgeContext.log('处理拍一拍事件出错:', error?.message ?? error); }
  });
bridgeContext.bot.on('open', () => bridgeContext.log(`SnowLuma 已连接：${bridgeContext.cfg.snowluma.wsUrl}`));
bridgeContext.bot.on('close', (info) => bridgeContext.log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`));
bridgeContext.bot.on('error', (error) => bridgeContext.log('SnowLuma 错误:', error));
await bridgeContext.bot.connect();
try {
    const login = await bridgeContext.bot.getLoginInfo();
    if (login?.nickname) {
      bridgeContext.selfNickname = String(login.nickname).toLowerCase();
      bridgeContext.log(`机器人昵称: ${login.nickname}`);
    }
  } catch {}
bridgeContext.log('桥接已启动。按 Ctrl+C 退出。');
if (bridgeContext.cfg.socialV2?.sticker?.enabled !== false) {
    bridgeContext.syncStickerLibrary(true).catch((error) => bridgeContext.log('启动预热表情库失败:', error?.message ?? error));
  }
bridgeContext.startDshWatch();
setInterval(bridgeContext.adaptiveTickV2, 60000);
bridgeContext.adaptiveTickV2();
bridgeContext.startConsoleServer();
await bridgeContext.pumpMux();
}
