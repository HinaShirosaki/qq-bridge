export function cancelReplyCheckV2(bridgeContext, key) {
    const st = bridgeContext.socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

export function scheduleReplyCheckV2(bridgeContext, key) {
    if (bridgeContext.cfg.socialV2?.enabled === false) return;
    if (bridgeContext.socialV2.paused || bridgeContext.currentMode !== 'reserved2') return;
    const st = bridgeContext.getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(bridgeContext.cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void bridgeContext.sendWakePromptV2(key, 'replyCheck').catch((error) => bridgeContext.log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    bridgeContext.log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

export function isConversationBusyV2(bridgeContext, key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (bridgeContext.pendingWakeKeys.has(key)) return true;
    const q = bridgeContext.promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = bridgeContext.state.sessions[key];
    if (sid && (bridgeContext.v2TurnStartAt.has(sid) || bridgeContext.collectors.has(sid))) return true;
    return false;
  }

export function busyReasonV2(bridgeContext, key, st) {
    const reasons = [];
    if (st && st.pendingWakeTimer) reasons.push('pendingWakeTimer');
    if (bridgeContext.pendingWakeKeys.has(key)) reasons.push('pendingWakeKeys');
    const q = bridgeContext.promptQueues.get(key);
    if (q && q.running) reasons.push(`promptQueue.running(${Math.round((Date.now() - (q.runningSince || Date.now())) / 1000)}s)`);
    else if (q && q.queue.length > 0) reasons.push(`promptQueue.queued(${q.queue.length})`);
    const sid = bridgeContext.state.sessions[key];
    if (sid && bridgeContext.v2TurnStartAt.has(sid)) reasons.push('v2TurnStartAt');
    if (sid && bridgeContext.collectors.has(sid)) reasons.push('collectors');
    return reasons.join('+') || 'unknown';
  }

export function wakePriorityV2(bridgeContext, reason) {
    const base = String(reason ?? '').split(':')[0];
    return bridgeContext.WAKE_PRIORITY[base] ?? 0;
  }

export function scheduleWakeV2(bridgeContext, key, reason) {
    if (bridgeContext.cfg.socialV2?.enabled === false) return;
    if (bridgeContext.socialV2.paused) return;
    if (!bridgeContext.isSessionAllowedInCurrentMode(key)) {
      bridgeContext.log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = bridgeContext.getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (bridgeContext.wakePriorityV2(reason) > bridgeContext.wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        bridgeContext.log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      } else {
        bridgeContext.log(`[reserved2] 合并窗口内忽略较低优先级 ${key}: ${reason}（当前 ${cur}）`); // 【本地补丁】诊断
      }
      return;
    }
    if (bridgeContext.isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq, at: Date.now() }); // 【本地补丁】记录入队时刻供看门狗判断
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      bridgeContext.log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）[原因: ${bridgeContext.busyReasonV2(key, st)}]`);
      return;
    }
    bridgeContext.cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeAt = Date.now(); // 【本地补丁】看门狗用
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      st.pendingWakeAt = 0;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void bridgeContext.sendWakePromptV2(key, finalReason).catch((error) => bridgeContext.log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    bridgeContext.log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

export function setupSleepTimerV2(bridgeContext, key) {
    if (bridgeContext.cfg.socialV2?.enabled === false) return;
    if (!bridgeContext.isSessionAllowedInCurrentMode(key)) return;
    const st = bridgeContext.getSocialV2State(key);
    bridgeContext.cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (bridgeContext.socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void bridgeContext.sendWakePromptV2(key, 'timeout').catch((error) => bridgeContext.log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 2147483647;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        bridgeContext.setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      bridgeContext.log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void bridgeContext.sendWakePromptV2(key, 'timeout').catch((error) => bridgeContext.log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    bridgeContext.log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

export function cancelProactiveCheckV2(bridgeContext, key) {
    const st = bridgeContext.socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

export function scheduleProactiveCheckV2(bridgeContext, key) {
    if (bridgeContext.cfg.socialV2?.proactive?.enabled === false) return;
    if (bridgeContext.socialV2.paused || bridgeContext.currentMode !== 'reserved2') return;
    if (!bridgeContext.isSessionAllowedInCurrentMode(key)) return;
    const st = bridgeContext.getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = bridgeContext.cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      bridgeContext.ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // Back off while nobody has spoken since the last proactive wake: each such wake halves the
      // next chance (floor 1/16), and any message or poke from someone resets it. A dead chat used to
      // get the same full-context wake every interval (private log: 97 of 100 turns, one message sent).
      const quietSinceLast = Number(st.lastProactiveAt) > Number(st.lastIncomingAt || 0);
      if (quietSinceLast && p.backoff !== false) prob *= 0.5 ** Math.min(4, st.proactiveStreak || 1);
      if (idle >= idleThreshold && Math.random() < prob && !bridgeContext.isConversationBusyV2(key, st)) {
        st.proactiveStreak = quietSinceLast ? (st.proactiveStreak || 1) + 1 : 1;
        st.lastProactiveAt = Date.now();
        void bridgeContext.sendWakePromptV2(key, 'proactiveCheck').catch((error) => bridgeContext.log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      bridgeContext.scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    bridgeContext.log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

export function drainPromptQueue(bridgeContext, key, errorMsg) {
    const entry = bridgeContext.promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    bridgeContext.promptQueues.delete(key);
  }

export function drainAllPromptQueues(bridgeContext, errorMsg) {
    for (const [, entry] of bridgeContext.promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    bridgeContext.promptQueues.clear();
  }

export function isSleepingConfigV2(bridgeContext, wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

