import { prepareSessionPrompt } from '../messaging/context.js';
import { mdToPlain } from "../md-to-plain.js";
import { SENSITIVE_RE } from "../sensitive.js";

export function redactKnownTokensOnly(bridgeContext, text) {
    let s = String(text ?? '');
    for (const token of bridgeContext.KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

export function hasExplicitEndV2(bridgeContext, st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return bridgeContext.EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

export function isSocialEnabled(bridgeContext) {
    return bridgeContext.currentMode === 'reserved' && bridgeContext.cfg.social?.enabled !== false;
  }

export function socialState(bridgeContext, key) {
    if (!bridgeContext.social.states.has(key)) {
      bridgeContext.social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return bridgeContext.social.states.get(key);
  }

export function isDirectAddress(bridgeContext, textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (bridgeContext.selfNickname && (lower.includes('@' + bridgeContext.selfNickname) || lower.includes(bridgeContext.selfNickname))) return true;
    for (const kw of (bridgeContext.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (bridgeContext.isDirectedAtAi(textContent)) return true;
    return false;
  }

export function isDirectedAtAi(bridgeContext, textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    // 【本地对账】角色可能随时切换（初音 / 小鲸鱼 / 其它），关键词取并集，避免换了角色就认不出自己的名字。
    const aiMention = /deepseek|claude|chatgpt|gpt|初音未来|初音|miku|ミク|葱葱|小鲸鱼|大肥鱼|鲸鱼|永雏塔菲|塔菲|永雏|taffy|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

export function isMustReplyText(bridgeContext, textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (bridgeContext.selfNickname && (lower.includes('@' + bridgeContext.selfNickname) || lower.includes(bridgeContext.selfNickname))) return true;
    for (const kw of (bridgeContext.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (bridgeContext.isDirectedAtAi(textContent)) return true;
    return false;
  }

export function appendRecentMessage(bridgeContext, key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!bridgeContext.social.recentMessages.has(key)) bridgeContext.social.recentMessages.set(key, []);
    const arr = bridgeContext.social.recentMessages.get(key);
    arr.push({
      sender,
      text: String(textContent).slice(0, 200),
      plain: String(plainText ?? textContent).slice(0, 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(bridgeContext.cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

export function appendSummary(bridgeContext, key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!bridgeContext.social.pendingSummaries.has(key)) {
      bridgeContext.social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = bridgeContext.social.pendingSummaries.get(key);
    entry.items.push({ sender, text: String(textContent).slice(0, 200), plain: String(plainText ?? textContent).slice(0, 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

export function buildContextBlock(bridgeContext, key) {
    const ctx = (bridgeContext.social.recentMessages.get(key) ?? []).slice(-Number(bridgeContext.cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${bridgeContext.mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

export function enterActive(bridgeContext, key) {
    const now = Date.now();
    const st = bridgeContext.socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + bridgeContext.randInt(Number(bridgeContext.cfg.social?.activeCheckMinMs ?? 20000), Number(bridgeContext.cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && bridgeContext.cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + bridgeContext.randInt(
        Number(bridgeContext.cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(bridgeContext.cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

export function cancelSocialTimers(bridgeContext, key) {
    const timers = bridgeContext.social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    bridgeContext.social.pendingTimers.delete(key);
  }

export function cancelAllSocialTimers(bridgeContext) {
    for (const timers of bridgeContext.social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    bridgeContext.social.pendingTimers.clear();
  }

export function cleanupSocialForModeChange(bridgeContext) {
    bridgeContext.cancelAllSocialTimers();
    bridgeContext.social.states.clear();
    bridgeContext.social.recentMessages.clear();
    bridgeContext.messageMediaStore.clear();
    bridgeContext.social.pendingSummaries.clear();
    bridgeContext.social.silentContext.clear();
    bridgeContext.social.silentTurns.clear();
    bridgeContext.social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of bridgeContext.promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    bridgeContext.promptQueues.clear();
  }

export function leaveActive(bridgeContext, key) {
    bridgeContext.cancelSocialTimers(key);
    bridgeContext.social.states.delete(key);
    bridgeContext.social.silentContext.delete(key);
  }

export function buildBatchPrompt(bridgeContext, key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${bridgeContext.mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${bridgeContext.DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${bridgeContext.SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${bridgeContext.SILENT_MARKER}；否则正常回复。\n${bridgeContext.SPACE_SPLIT_HINT}`;
  }

export function buildProbePrompt(bridgeContext, key) {
    return `【群聊上下文】\n${bridgeContext.buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${bridgeContext.SILENT_MARKER}。\n${bridgeContext.SPACE_SPLIT_HINT}`;
  }

export function buildActiveExitPrompt(bridgeContext, key) {
    let p = '';
    p += `【群聊上下文】\n${bridgeContext.buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

export function triggerActiveDurationExit(bridgeContext, key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (bridgeContext.cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    bridgeContext.cancelSocialTimers(key);
    const promptText = bridgeContext.buildActiveExitPrompt(key);
    bridgeContext.scheduleSocialReply(
      key, promptText,
      Number(bridgeContext.cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(bridgeContext.cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    bridgeContext.log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

export function buildProactivePrompt(bridgeContext, key) {
    let p = '';
    p += `【群聊上下文】\n${bridgeContext.buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${bridgeContext.SILENT_MARKER}。\n${bridgeContext.SPACE_SPLIT_HINT}`;
    return p;
  }

export async function deliverPromptNow(bridgeContext, key, promptText, opts = {}) {
    if (!bridgeContext.dshReady) {
      const items = bridgeContext.queued.get(key) ?? [];
      if (items.length >= bridgeContext.QUEUE_MAX) {
        items.shift();
        bridgeContext.log(`队列满（${bridgeContext.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      bridgeContext.queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await bridgeContext.ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        bridgeContext.enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    const imageParts = Array.isArray(opts.media) && opts.media.length
      ? await bridgeContext.resolveMediaList(opts.media) : [];
    const prepared = prepareSessionPrompt(bridgeContext, key, sessionId, promptText);
    const content = [{ type: 'text', text: prepared.text }, ...imageParts];
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (opts.farewell) bridgeContext.social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await bridgeContext.api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) bridgeContext.social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) bridgeContext.social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent && !bridgeContext.isCodexNoise(errText)) await bridgeContext.sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      else if (bridgeContext.isCodexNoise(errText)) bridgeContext.log(`[codex] 投递被拒，已对 QQ 静默：${errText.slice(0, 200)}`);
      return { ok: false, error: safeErrText };
    }
    prepared.commit();
    if (accepted.result.value.command?.text && !opts.silent && bridgeContext.currentMode !== 'reserved2') {
      if (opts.farewell) bridgeContext.social.exitingSessions.delete(sessionId);
      await bridgeContext.auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      bridgeContext.social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

export function deliverPrompt(bridgeContext, key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = bridgeContext.promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        bridgeContext.promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      bridgeContext.processPromptQueue(key);
    });
  }

export async function processPromptQueue(bridgeContext, key) {
    const entry = bridgeContext.promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) bridgeContext.promptQueues.delete(key);
      return;
    }
    entry.running = true;
    entry.runningSince = Date.now();
    entry.epoch = (entry.epoch ?? 0) + 1;
    const myEpoch = entry.epoch;
    try {
      const result = await bridgeContext.deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      // 看门狗可能已判定这条投递卡死并复位（epoch 变化）：此时不再动状态，
      // 否则会和新的投递并发打架（重复投递 / 误删新队列）。
      if (entry.epoch !== myEpoch) return;
      entry.running = false;
      entry.runningSince = 0;
      if (entry.queue.length) bridgeContext.processPromptQueue(key);
      // 只在 map 里还是自己这条时才删：DSH 断连清理可能已经换成了新 entry，
      // 否则会把恢复后刚入队的投递一起删掉。
      else if (bridgeContext.promptQueues.get(key) === entry) bridgeContext.promptQueues.delete(key);
    }
  }

export function scheduleSocialReply(bridgeContext, key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = bridgeContext.randInt(minDelay, maxDelay);
    bridgeContext.log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = bridgeContext.social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) bridgeContext.social.pendingTimers.delete(key);
      }
      bridgeContext.deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => bridgeContext.log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = bridgeContext.social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    bridgeContext.social.pendingTimers.set(key, timers);
  }

export function socialLoopTick(bridgeContext) {
    if (!bridgeContext.isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...bridgeContext.social.states.keys(), ...bridgeContext.social.recentMessages.keys()]);
    for (const key of keys) {
      const st = bridgeContext.socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (bridgeContext.cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = bridgeContext.social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(bridgeContext.cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + bridgeContext.randInt(Number(bridgeContext.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(bridgeContext.cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + bridgeContext.randInt(Number(bridgeContext.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(bridgeContext.cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(bridgeContext.cfg.social?.proactiveProbability ?? 0.2)) {
                bridgeContext.enterActive(key);
                const promptText = bridgeContext.buildProactivePrompt(key);
                bridgeContext.scheduleSocialReply(
                  key, promptText,
                  Number(bridgeContext.cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(bridgeContext.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                bridgeContext.log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (bridgeContext.triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (bridgeContext.social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + bridgeContext.randInt(Number(bridgeContext.cfg.social?.activeCheckMinMs ?? 20000), Number(bridgeContext.cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || bridgeContext.isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(bridgeContext.cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                bridgeContext.log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = bridgeContext.social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                bridgeContext.social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) bridgeContext.appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = bridgeContext.social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            bridgeContext.social.silentContext.delete(key);
            const promptText = bridgeContext.buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            bridgeContext.scheduleSocialReply(
              key, promptText,
              Number(bridgeContext.cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(bridgeContext.cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            bridgeContext.log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(bridgeContext.cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(bridgeContext.cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(bridgeContext.cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = bridgeContext.buildProbePrompt(key);
              bridgeContext.scheduleSocialReply(
                key, promptText,
                Number(bridgeContext.cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(bridgeContext.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              bridgeContext.log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              bridgeContext.leaveActive(key);
              bridgeContext.log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          bridgeContext.log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = bridgeContext.state.sessions[key];
          if (sid) bridgeContext.social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        bridgeContext.leaveActive(key);
        bridgeContext.log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

export function startSocialLoop(bridgeContext) {
    if (bridgeContext.social.loopTimer) clearInterval(bridgeContext.social.loopTimer);
    bridgeContext.social.loopTimer = setInterval(bridgeContext.socialLoopTick, 5000);
    bridgeContext.social.loopTimer.unref?.();
  }
