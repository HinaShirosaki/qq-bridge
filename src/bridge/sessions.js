import fs from 'node:fs';

import path from 'node:path';

import { unwrap } from "../dsh-client.js";

import { normalizeOwnerQQ } from "./config.js";

export async function refreshMode(bridgeContext) {
    try {
      const s = unwrap(await bridgeContext.api.settings.describe({}), 'settings.describe');
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      if (ns?.value && typeof ns.value.mode === 'string' && bridgeContext.VALID_MODES.includes(ns.value.mode)) {
        bridgeContext.currentMode = ns.value.mode;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            bridgeContext.cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            bridgeContext.log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        return;
      }
    } catch {}
    const local = bridgeContext.readJsonSafe(path.join(bridgeContext.STATE_DIR, 'mode.json'), null);
    if (local?.mode && bridgeContext.VALID_MODES.includes(local.mode)) bridgeContext.currentMode = local.mode;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      bridgeContext.closedAgentPreset = local.closedAgentPreset;
    }
  }

export function modeAllowed(bridgeContext, key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return bridgeContext.allowed(kind, id, cfg);
  }

export function modePreset(bridgeContext, key, mode, cfg) {
    if (mode === 'closed-agent') return bridgeContext.closedAgentPreset || 'router-standard';
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设
    if (mode === 'reserved2') return cfg.socialV2?.agentPreset || cfg.agentPreset || undefined;
    return cfg.agentPreset || undefined;
  }

export function isSessionAllowedInCurrentMode(bridgeContext, key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return bridgeContext.modeAllowed(key, m[1], Number(m[2]), bridgeContext.cfg, bridgeContext.currentMode);
  }

export function adaptiveProbabilityFor(bridgeContext, rate) {
    for (const b of bridgeContext.ADAPTIVE_WAKE_BUCKETS) if (rate < b.below) return b.probability;
    return bridgeContext.ADAPTIVE_WAKE_BUCKETS[bridgeContext.ADAPTIVE_WAKE_BUCKETS.length - 1].probability;
  }

export function adaptiveTickV2(bridgeContext) {
    const w = bridgeContext.cfg.socialV2?.wake ?? {};
    if (w.adaptiveEnabled === false) return;
    if (bridgeContext.currentMode !== 'reserved2' || bridgeContext.socialV2.paused) return;
    const windowMs = Math.max(30000, Number(w.adaptiveWindowMs) || 180000);
    const minP = Number.isFinite(Number(w.adaptiveMinProbability)) ? Number(w.adaptiveMinProbability) : 0.01;
    const maxP = Number.isFinite(Number(w.adaptiveMaxProbability)) ? Number(w.adaptiveMaxProbability) : 0.3;
    for (const [key, st] of bridgeContext.socialV2.conversations) {
      try {
        // 【本地补丁】看门狗：唤醒定时器本该在 batchWindowMs 后触发，
        // 一旦它的回调丢失（实测出现过：@ 命中后 20 分钟一次唤醒都没有、日志零痕迹），
        // pendingWakeTimer 会永久为真，后续所有 @ 都被"合并窗口"静默吞掉。
        // 这里把明显超期的定时器复位，让唤醒通道自愈。
        // 【本地补丁】孤立 turn collector 清理：桥接重启/重连后，events.mux 可能补推历史事件，
        // 让 collectors 里留下一个没有对应 turn/start 的条目录（无 v2TurnStartAt、也无在途投递），
        // 于是 isConversationBusyV2() 恒为真、该会话所有唤醒都被判"繁忙"（实测重启后卡了 2 分半）。
        // 真实在跑的回合一定在 turn/start 时写过 v2TurnStartAt，所以这个组合可以安全清理。
        {
          const csid = bridgeContext.state.sessions[key];
          if (csid && bridgeContext.collectors.has(csid) && !bridgeContext.v2TurnStartAt.has(csid) && !(bridgeContext.promptQueues.get(key)?.running)) {
            bridgeContext.collectors.delete(csid);
            bridgeContext.log(`[reserved2] 清理孤立 turn collector ${key}`);
          }
        }
        // 【本地补丁】投递队列看门狗：deliverPromptNow 等不到 turn/end 时
        // promptQueues[key].running 会永久为 true，导致该会话此后所有唤醒都被判"繁忙"
        // 而永远不投递（实测群会话卡住 10 分钟、codex 请求一次都没发出）。
        // 超过 3 分钟没进展就复位（靠 epoch 让旧的那次投递自动失效）。
        const qe = bridgeContext.promptQueues.get(key);
        if (qe && qe.running && qe.runningSince && Date.now() - qe.runningSince > 180000) {
          const heldS = Math.round((Date.now() - qe.runningSince) / 1000);
          qe.epoch = (qe.epoch ?? 0) + 1; // 让卡住那次的 finally 变成空操作
          qe.running = false;
          qe.runningSince = 0;
          bridgeContext.log(`[reserved2] 投递卡死已复位 ${key}（挂起 ${heldS}s），继续排空队列`);
          if (qe.queue.length) bridgeContext.processPromptQueue(key);
        }
        // 【本地补丁】等待看门狗：长轮询按设计最长约 timeoutMs+maxQuietMs（≈7 分钟），
        // 超过 8 分钟仍未释放就强制解除占用，避免 AI 永远吃 429、误以为"桥接卡住了"。
        const waitAt = bridgeContext.activeWaitSince.get(key);
        if (waitAt && Date.now() - waitAt > 480000) {
          const heldS = Math.round((Date.now() - waitAt) / 1000);
          bridgeContext.activeWaits.delete(key);
          bridgeContext.activeWaitSince.delete(key);
          bridgeContext.log(`[reserved2] 等待请求超时未释放，已强制解除占用 ${key}（挂起 ${heldS}s）`);
        }
        if (st?.pendingWakeTimer && st.pendingWakeAt && Date.now() - st.pendingWakeAt > 120000) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
          st.pendingWakeAt = 0;
          bridgeContext.log(`[reserved2] 唤醒定时器卡死已复位 ${key}（挂起 ${Math.round((Date.now() - (st.pendingWakeAt || Date.now())) / 1000)}s）`);
        }
        // 【本地补丁】排队唤醒卡死看门狗。
        // pendingWakeReasons 只在 turn/end 时排空；如果"会话繁忙"是过期标记（实际没有回合在跑），
        // 就永远等不到 turn/end，@ 会卡在队列里无限期不处理（实测 03:50 那条 @ 就这样丢了）。
        // 判定：排队最久的一条超过 120 秒，且没有近期的真实 turn 在跑 → 清掉过期繁忙标记并重放。
        const q = Array.isArray(st?.pendingWakeReasons) ? st.pendingWakeReasons : [];
        if (q.length) {
          const oldestAt = Math.min(...q.map((r) => Number(r?.at || 0)).filter((n) => n > 0));
          const sid = bridgeContext.state.sessions[key];
          const turnStartedAt = sid ? bridgeContext.v2TurnStartAt.get(sid) : 0;
          const reallyRunning = Number(turnStartedAt) > 0 && Date.now() - Number(turnStartedAt) < 600000;
          if (oldestAt && Date.now() - oldestAt > 120000 && !reallyRunning) {
            const best = [...q].filter((r) => r && typeof r === 'object')
              .sort((a, b) => bridgeContext.wakePriorityV2(b.reason) - bridgeContext.wakePriorityV2(a.reason))[0];
            bridgeContext.collectors.delete(sid);
            bridgeContext.v2TurnStartAt.delete(sid);
            bridgeContext.pendingWakeKeys.delete(key);
            st.pendingWakeReasons.length = 0;
            bridgeContext.saveSocialV2State();
            if (best) {
              bridgeContext.log(`[reserved2] 排队唤醒超时 ${Math.round((Date.now() - oldestAt) / 1000)}s 未处理，强制恢复并重放 ${key}（${best.reason}）`);
              bridgeContext.scheduleWakeV2(key, best.reason);
            } else {
              bridgeContext.log(`[reserved2] 排队唤醒超时，已清理 ${key}（无有效原因）`);
            }
            continue;
          }
        }
        if (!bridgeContext.isSessionAllowedInCurrentMode(key)) continue;
        const triggers = st?.wakeConfig?.triggers;
        if (!triggers) continue;
        const now = Date.now();
        const msgs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
        const count = msgs.filter((m) => m && !m.isSelf && now - Number(m.time || 0) <= windowMs).length;
        const rate = count / (windowMs / 60000);
        // 【本地补丁】整体倍率：一个旋钮就能把"聊天频率"按倍调高/调低，不用改分档表
        const scaleRaw = Number(w.adaptiveProbabilityScale);
        const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;
        const target = Math.min(maxP, Math.max(minP, bridgeContext.adaptiveProbabilityFor(rate) * scale));
        const cur = Number(triggers.probability) || 0;
        if (Math.abs(cur - target) < 1e-9) continue;
        triggers.probability = target;
        bridgeContext.saveSocialV2State();
        bridgeContext.log(`[reserved2] 自适应唤醒 ${key}：${rate.toFixed(2)} 条/分钟（最近 ${Math.round(windowMs / 60000)} 分钟 ${count} 条）→ 概率 ${cur} -> ${target}`);
      } catch (error) {
        bridgeContext.log(`自适应唤醒计算失败 ${key}:`, error?.message ?? error);
      }
    }
  }

export function startDshWatch(bridgeContext) {
    if (bridgeContext.dshCheckStarted) return;
    bridgeContext.dshCheckStarted = true;
    bridgeContext.checkDsh();
    setInterval(bridgeContext.checkDsh, 5000);
  }

export async function ensureVisionModel(bridgeContext, sessionId) {
    // 【本地补丁】只在 codex 确实接管该会话时跳过；回退到 DSH 时必须照常应用模型设置
    if (bridgeContext.cfg.replyBackend === 'local-codex' && bridgeContext.api.replyRouteOwns?.(sessionId)) return;
    if (bridgeContext.visionModelAppliedSessions.has(sessionId)) return;
    const provider = String(bridgeContext.cfg.dsh?.provider || 'deepseek-official');
    const model = String(bridgeContext.cfg.dsh?.model || 'deepseek-v4-flash-vision-exp');
    const effort = String(bridgeContext.cfg.dsh?.reasoningEffort || 'max');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await bridgeContext.api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        bridgeContext.visionModelAppliedSessions.add(sessionId);
        bridgeContext.log(`已设置会话视觉模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return;
      } catch (error) {
        bridgeContext.log(`设置会话视觉模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await bridgeContext.sleep(1000);
      }
    }
  }

export async function ensureSession(bridgeContext, key) {
    const epoch = bridgeContext.sessionEpoch;
    const existing = bridgeContext.state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (epoch !== bridgeContext.sessionEpoch) {
        delete bridgeContext.state.sessions[key];
        if (bridgeContext.reverse.get(existing) === key) bridgeContext.reverse.delete(existing);
        try { await bridgeContext.api.workspace.archiveSession({ sessionId: existing }); } catch {}
      } else {
        await bridgeContext.ensureVisionModel(existing);
        return existing;
      }
    }
    if (bridgeContext.sessionPromises.has(key)) return bridgeContext.sessionPromises.get(key);
    const promise = (async () => {
      const dir = bridgeContext.cfg.sessionCwd ? String(bridgeContext.cfg.sessionCwd) : path.join(bridgeContext.STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      for (const withPreset of [true, false]) {
        try {
          const wsValue = unwrap(await bridgeContext.api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && bridgeContext.cfg.workspaceTitle) {
            await bridgeContext.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: bridgeContext.cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          const preset = bridgeContext.modePreset(key, bridgeContext.currentMode, bridgeContext.cfg);
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await bridgeContext.api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        bridgeContext.log(`归组创建失败（${lastError?.message}），回退无参创建`);
        const value = unwrap(await bridgeContext.api.sessions.create({}), 'session.create');
        sessionId = value.sessionId;
      }
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== bridgeContext.sessionEpoch) {
        bridgeContext.log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await bridgeContext.api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      bridgeContext.state.sessions[key] = sessionId;
      bridgeContext.reverse.set(sessionId, key);
      bridgeContext.saveState();
      await bridgeContext.ensureVisionModel(sessionId);
      bridgeContext.log(`新会话 ${key} -> ${sessionId}（模式 ${bridgeContext.currentMode}，preset: ${bridgeContext.modePreset(key, bridgeContext.currentMode, bridgeContext.cfg) ?? '默认'}）`);
      return sessionId;
    })();
    bridgeContext.sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (bridgeContext.sessionPromises.get(key) === promise) bridgeContext.sessionPromises.delete(key);
    }
  }
