import { invalidatePromptContext } from '../messaging/context.js';
import { createTurnCollector } from "../dsh-client.js";

import { mdToPlain } from "../md-to-plain.js";
import { SENSITIVE_RE } from "../sensitive.js";
import { markReadV2 } from "../social/wake-triggers.js";

export async function handleMuxEnvelope(bridgeContext, envelope) {
    const frame = envelope.payload;
    // Ignore old DSH inference events for conversations now owned by local Codex.
    // 【本地补丁】原来这里按静态配置 replyBackend 过滤 DSH 事件，一旦回退到 DSH，
    // 该会话的 turn/end 会被全部丢弃 → 桥接永远认为"回合在跑"，进而卡住所有 @。
    // 现在只过滤"本次回合确实被 codex 接管"的会话。
    // 兼容两种 router：failover 版用 status().owners[key].backend 判定；内置简化版用 replyRouteOwns。
    let codexOwnsThis = false;
    try {
      const ownerKey = bridgeContext.reverse.get(frame.sessionId);
      const owners = bridgeContext.api.replyRouteStatus?.()?.owners;
      if (ownerKey && owners && owners[ownerKey]) codexOwnsThis = owners[ownerKey].backend === 'local-codex';
      else if (typeof bridgeContext.api.replyRouteOwns === 'function') codexOwnsThis = bridgeContext.api.replyRouteOwns(frame.sessionId) === true;
    } catch {}
    if (bridgeContext.cfg.replyBackend === 'local-codex' && !envelope.localCodex && codexOwnsThis &&
        (bridgeContext.reverse.has(frame.sessionId) || bridgeContext.learnerSessions.has(frame.sessionId))) return;
    if (frame.type === 'session/event') {
      if (frame.event.type === 'compaction/end') {
        if (bridgeContext.reverse.has(frame.sessionId)) invalidatePromptContext(bridgeContext, frame.sessionId);
        return; // A manual compaction outside a turn must not leave a phantom busy collector.
      }
      const key = bridgeContext.reverse.get(frame.sessionId);
      if (!key) {
        // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
        if (bridgeContext.learnerSessions.has(frame.sessionId)) {
          const learnerCollector = bridgeContext.learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
          bridgeContext.learnerCollectors.set(frame.sessionId, learnerCollector);
          const learnerEnded = learnerCollector.push(frame.event);
          if (learnerEnded) {
            bridgeContext.learnerCollectors.delete(frame.sessionId);
            const waiters = bridgeContext.learnerWaiters.get(frame.sessionId) ?? [];
            const waiter = waiters.shift();
            if (waiters.length === 0) bridgeContext.learnerWaiters.delete(frame.sessionId);
            if (waiter) {
              clearTimeout(waiter.timer);
              if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                waiter.resolve(learnerEnded.text);
              } else {
                waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
              }
            }
            // 旧学习会话 turn 结束后从集合移除，避免残留
            if (frame.sessionId !== bridgeContext.slangLearnerSessionId) bridgeContext.learnerSessions.delete(frame.sessionId);
          }
        }
        return;
      }
      // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
      // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
      if (frame.event.type === 'turn/start') {
        bridgeContext.sendToolSucceededSessions.delete(frame.sessionId);
        bridgeContext.pendingSendToolCalls.delete(frame.sessionId);
        bridgeContext.v2TurnStartAt.set(frame.sessionId, Date.now());
      }
      if (frame.event.type === 'tool/call') {
        const toolName = String(frame.event.data?.name ?? '');
        const callId = frame.event.data?.callId;
        const args = bridgeContext.sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
        bridgeContext.appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
        if (callId != null) {
          if (bridgeContext.isSendToolName(toolName)) {
            let pending = bridgeContext.pendingSendToolCalls.get(frame.sessionId);
            if (!pending) {
              pending = new Set();
              bridgeContext.pendingSendToolCalls.set(frame.sessionId, pending);
            }
            pending.add(callId);
          }
          let nameMap = bridgeContext.toolCallNames.get(frame.sessionId);
          if (!nameMap) {
            nameMap = new Map();
            bridgeContext.toolCallNames.set(frame.sessionId, nameMap);
          }
          nameMap.set(String(callId), toolName);
        }
      }
      if (frame.event.type === 'tool/result') {
        const callId = frame.event.data?.message?.source?.callId;
        const toolName = callId != null ? (bridgeContext.toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
        const resultBlock = frame.event.data?.message?.content?.[0];
        const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
        const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
        bridgeContext.appendToolLog({
          type: 'result',
          time: new Date().toISOString(),
          key,
          sessionId: frame.sessionId,
          tool: toolName,
          ok: !resultError,
          error: errorText ? bridgeContext.sanitizeToolArgs(errorText) : null
        });
        if (callId != null) {
          bridgeContext.toolCallNames.get(frame.sessionId)?.delete(String(callId));
          const pending = bridgeContext.pendingSendToolCalls.get(frame.sessionId);
          if (pending?.has(callId)) {
            pending.delete(callId);
            if (pending.size === 0) bridgeContext.pendingSendToolCalls.delete(frame.sessionId);
            if (!resultError) {
              bridgeContext.sendToolSucceededSessions.add(frame.sessionId);
            }
          }
        }
      }
      const collector = bridgeContext.collectors.get(frame.sessionId) ?? createTurnCollector();
      bridgeContext.collectors.set(frame.sessionId, collector);
      const ended = collector.push(frame.event);
      if (ended) {
        // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
        // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
        const silentQueueNow = bridgeContext.social.silentTurns.get(frame.sessionId) ?? [];
        const isSilentTurn = silentQueueNow.length > 0;
        if (bridgeContext.currentMode === 'reserved2' && key && !isSilentTurn) {
          const st = bridgeContext.getSocialV2State(key);
          const turnStart = bridgeContext.v2TurnStartAt.get(frame.sessionId) ?? 0;
          // With implicitWrapUp, a completed turn that ends quietly is a decision ("seen, not joining"), not a stall.
          const quietDecision = bridgeContext.cfg.tokenOptimization?.implicitWrapUp !== false && ended.reason?.kind === 'completed';
          const actionTaken = quietDecision || bridgeContext.sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
          if (actionTaken) {
            st.wakeConfig.noActionCount = 0;
          } else {
            st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
            const limit = Number(bridgeContext.cfg.socialV2?.wake?.noActionLimit) || 3;
            if (st.wakeConfig.noActionCount >= limit) {
              bridgeContext.log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
              st.wakeConfig = bridgeContext.defaultWakeConfigV2();
              st.bootstrapSent = true;
              st.wakeConfig.noActionCount = 0;
            }
          }
          bridgeContext.saveSocialV2State();
        }
        bridgeContext.v2TurnStartAt.delete(frame.sessionId);
        bridgeContext.collectors.delete(frame.sessionId);
        const sendToolSucceeded = bridgeContext.sendToolSucceededSessions.has(frame.sessionId);
        bridgeContext.sendToolSucceededSessions.delete(frame.sessionId);
        bridgeContext.pendingSendToolCalls.delete(frame.sessionId);
        bridgeContext.toolCallNames.delete(frame.sessionId);
        // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
        const isFarewell = bridgeContext.social.exitingSessions.has(frame.sessionId);
        if (isFarewell) bridgeContext.social.exitingSessions.delete(frame.sessionId);
        // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
        // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
        const silentQueue = bridgeContext.social.silentTurns.get(frame.sessionId) ?? [];
        const silentNow = Date.now();
        while (silentQueue.length && silentNow - silentQueue[0].ts > bridgeContext.SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
        if (silentQueue.length > 0) {
          silentQueue.shift();
          if (silentQueue.length > 0) bridgeContext.social.silentTurns.set(frame.sessionId, silentQueue);
          else bridgeContext.social.silentTurns.delete(frame.sessionId);
          bridgeContext.log(`摘要投喂 turn 结束，静默 (${key})`);
          return;
        }
        // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
        // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
        if (bridgeContext.pendingWakeKeys.has(key)) {
          bridgeContext.pendingWakeKeys.delete(key);
          bridgeContext.disarmPendingWakeLease(key);
          if (bridgeContext.wakeConfigUpdatedKeys.has(key) || bridgeContext.markReadCalledKeys.has(key)) {
            bridgeContext.ensureWakeableV2(bridgeContext.getSocialV2State(key), { key });
            bridgeContext.wakeConfigUpdatedKeys.delete(key);
            bridgeContext.markReadCalledKeys.delete(key);
            bridgeContext.wakeConfigMissCount.delete(key);
          } else {
            // Implicit wrap-up: a completed turn without qq_mark_read / qq_set_wake_config counts as
            // mark_read with the current wake config. Saves the wrap-up call plus the model step after
            // it, and the reminder turn. Failed/aborted turns still get the reminder below.
            const stWrap = bridgeContext.getSocialV2State(key);
            const implicit = bridgeContext.cfg.tokenOptimization?.implicitWrapUp !== false && ended.reason?.kind === 'completed'
              ? markReadV2(bridgeContext, key, stWrap, 'turn_end', stWrap.wakeSeenSeq ?? 0)
              : null;
            if (implicit) {
              bridgeContext.wakeConfigMissCount.delete(key);
              bridgeContext.log(`[reserved2] ${key} 回合结束未显式收尾，按已读处理：${implicit.markedCount} 条${implicit.observeMs ? `，后台观察 ${Math.round(implicit.observeMs / 1000)}s` : ''}`);
            } else {
              const currentMiss = (bridgeContext.wakeConfigMissCount.get(key) ?? 0) + 1;
              const maxReminders = Number(bridgeContext.cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
              if (currentMiss < maxReminders) {
                bridgeContext.wakeConfigMissCount.set(key, currentMiss);
                bridgeContext.pendingWakeKeys.add(key);
                bridgeContext.armPendingWakeLease(key);
                bridgeContext.deliverPrompt(key, bridgeContext.buildWakeReminderPromptV2(key)).then((result) => {
                  if (result && result.ok === false) {
                    bridgeContext.pendingWakeKeys.delete(key);
                    bridgeContext.disarmPendingWakeLease(key);
                  }
                }).catch((error) => {
                  bridgeContext.pendingWakeKeys.delete(key);
                  bridgeContext.disarmPendingWakeLease(key);
                  bridgeContext.log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                });
                bridgeContext.log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
              } else {
                const st = bridgeContext.getSocialV2State(key);
                st.wakeConfig = bridgeContext.defaultWakeConfigV2();
                bridgeContext.saveSocialV2State();
                bridgeContext.log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
              }
            }
          }
        }
        // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
        // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
        {
          const stEnd = bridgeContext.getSocialV2State(key);
          if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
            const item = stEnd.pendingWakeReasons.shift();
            if (!item || typeof item !== 'object') {
              // 兼容旧字符串残留
            } else {
              const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
              if (stillRelevant) {
                bridgeContext.log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                bridgeContext.scheduleWakeV2(key, item.reason);
              } else {
                bridgeContext.log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
              }
            }
          }
        }
        if (ended.reason.kind === 'completed' && ended.text.trim()) {
          const plain = mdToPlain(ended.text);
          // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
          if (!plain.trim()) {
            bridgeContext.log(`agent 回复为空（仅格式/空白）(${key})`);
            if (isFarewell) {
              const st = bridgeContext.socialState(key);
              if (st.phase === 'exiting') {
                st.phase = 'idle';
                st.activeDeadlineAt = 0;
                st.activeExitAt = 0;
                bridgeContext.log(`社交模式：${key} 空退场回合，回到观望`);
              }
            }
            return;
          }
          // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
          if (bridgeContext.isSilentMarker(plain)) {
            bridgeContext.log(`社交模式：AI 选择静默（${bridgeContext.SILENT_MARKER}）(${key})`);
            if (isFarewell) {
              const st = bridgeContext.socialState(key);
              if (st.phase === 'exiting') {
                st.phase = 'idle';
                st.activeDeadlineAt = 0;
                st.activeExitAt = 0;
                bridgeContext.log(`社交模式：${key} 退场选择静默，回到观望`);
              }
            }
            return;
          }
          // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
          if (sendToolSucceeded) {
            bridgeContext.log(`工具已发送消息，跳过自动转发 (${key})`);
            if (isFarewell) {
              const st = bridgeContext.socialState(key);
              if (st.phase === 'exiting') {
                st.phase = 'idle';
                st.activeDeadlineAt = 0;
                st.activeExitAt = 0;
                bridgeContext.log(`社交模式：${key} 工具发送后退场完成，回到观望`);
              }
            }
            return;
          }
          // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
          const hasKnownToken = [...bridgeContext.KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
          if (bridgeContext.shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
            bridgeContext.log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
            bridgeContext.appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
            if (bridgeContext.cfg.security?.interceptNotify !== false) {
              await bridgeContext.sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
            }
            if (isFarewell) {
              const st = bridgeContext.socialState(key);
              if (st.phase === 'exiting') {
                st.phase = 'idle';
                st.activeDeadlineAt = 0;
                st.activeExitAt = 0;
                bridgeContext.log(`社交模式：${key} 退场发言被拦截，回到观望`);
              }
            }
            return;
          }
          // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
          if (bridgeContext.isSocialEnabled()) {
            if (bridgeContext.shouldBlockSilentReply(key)) {
              bridgeContext.log(`静默模式，拦截在途回复 (${key})`);
              bridgeContext.appendActivity(`${key} 静默模式，拦截在途回复`);
              if (isFarewell) {
                const st = bridgeContext.socialState(key);
                if (st.phase === 'exiting') {
                  st.phase = 'idle';
                  st.activeDeadlineAt = 0;
                  st.activeExitAt = 0;
                  bridgeContext.log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                }
              }
              return;
            }
            const timeline = bridgeContext.planSocialTimeline(plain, bridgeContext.cfg.social);
            const messages = timeline.main;
            bridgeContext.log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
            bridgeContext.appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
            if (messages.length > 1) {
              await bridgeContext.sendBurstToQQ(key, messages, bridgeContext.cfg.social);
            } else {
              await bridgeContext.sendToQQ(key, messages[0]);
            }
            // 发言后刷新活跃时间，并调度可能的二次补刀
            const st = bridgeContext.socialState(key);
            if (isFarewell) {
              // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              bridgeContext.log(`社交模式：${key} 退场发言完成，进入观望`);
            } else if (st.phase === 'exiting') {
              // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
              bridgeContext.log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
            } else {
              st.lastActiveMessageAt = Date.now();
              st.lastAiReplyAt = Date.now();
              bridgeContext.log(`社交模式：发言完成，刷新活跃时间 (${key})`);
            }
          } else if (bridgeContext.currentMode === 'reserved2') {
            bridgeContext.log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
            bridgeContext.appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
          } else {
            if (bridgeContext.shouldBlockSilentReply(key)) {
              bridgeContext.log(`静默模式，拦截在途回复 (${key})`);
              bridgeContext.appendActivity(`${key} 静默模式，拦截在途回复`);
              return;
            }
            bridgeContext.log(`agent 回复 (${key}) ${plain.length} 字`);
            bridgeContext.appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
            await bridgeContext.sendToQQ(key, plain);
          }
        } else if (ended.reason.kind === 'error') {
          const msg = ended.reason.error?.message ?? '未知错误';
          const safeMsg = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
          if (bridgeContext.isCodexNoise(msg)) {
            // codex 侧故障一律不打扰 QQ 用户（已自动降级到 DSH，这里只是记录）
            bridgeContext.log(`[codex] 回合出错，已对 QQ 静默：${String(msg).slice(0, 200)}`);
          } else {
            await bridgeContext.sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
          }
          if (isFarewell) {
            const st = bridgeContext.socialState(key);
            if (st.phase === 'exiting') {
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              bridgeContext.log(`社交模式：${key} 退场发言出错，回到观望`);
            }
          }
        } else if (ended.reason.kind === 'aborted') {
          await bridgeContext.sendToQQ(key, '⏹️ 已停止');
          if (isFarewell) {
            const st = bridgeContext.socialState(key);
            if (st.phase === 'exiting') {
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              bridgeContext.log(`社交模式：${key} 退场发言中止，回到观望`);
            }
          }
        } else if (!ended.text.trim()) {
          // completed 但没文本（纯工具调用回合）
          bridgeContext.log(`回合完成但无文本 (${key})`);
          if (isFarewell) {
            const st = bridgeContext.socialState(key);
            if (st.phase === 'exiting') {
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              bridgeContext.log(`社交模式：${key} 退场回合无文本，回到观望`);
            }
          }
        }
      }
    } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && bridgeContext.learnerSessions.has(frame.sessionId)) {
      // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
      try {
        if (frame.type === 'question/requested') {
          await bridgeContext.api.respond({
            type: 'client-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } } }
          });
        } else {
          await bridgeContext.api.respond({
            type: 'client-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' } }
          });
        }
        bridgeContext.log('黑话学习会话自动跳过提问/审批');
      } catch (error) {
        bridgeContext.log('自动响应学习会话提问/审批失败:', error?.message ?? error);
      }
    } else if (frame.type === 'question/requested') {
      const key = bridgeContext.reverse.get(frame.sessionId);
      if (!key) return;
      const lines = frame.questions.map((q, i) => {
        const qText = String(q.question ?? '');
        const sensitive = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(qText);
        if (sensitive) bridgeContext.log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
        const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
        let s = `${i + 1}. ${safeQuestion}`;
        if (q.options?.length) {
          const opts = q.options.map((o) => {
            const label = String(o.label ?? '');
            const optSensitive = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(label);
            if (optSensitive) bridgeContext.log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
            return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
          });
          s += '\n   ' + opts.join(' ');
        }
        return s;
      });
      await bridgeContext.sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
      await bridgeContext.registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, questions: frame.questions });
    } else if (frame.type === 'approval/requested') {
      const key = bridgeContext.reverse.get(frame.sessionId);
      if (!key) return;
      const rawReason = frame.reason ?? '';
      const sensitiveReason = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
      if (sensitiveReason) bridgeContext.log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
      const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
      const reason = safeReason ? `\n理由：${safeReason}` : '';
      const rawToolName = frame.toolName ?? '';
      const sensitiveTool = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
      if (sensitiveTool) bridgeContext.log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
      const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
      await bridgeContext.sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
      await bridgeContext.registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName });
    } else if (frame.type === 'stream/error') {
      bridgeContext.log('事件流错误:', frame.error);
    }
  }

export async function pumpMux(bridgeContext) {
    for (;;) {
      try {
        bridgeContext.log('连接 DSH 事件流…');
        for await (const envelope of bridgeContext.api.events.mux({})) {
          await bridgeContext.handleMuxEnvelope(envelope);
        }
      } catch (error) {
        bridgeContext.log('事件流中断:', error?.message ?? error);
        bridgeContext.collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        bridgeContext.social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        bridgeContext.sendToolSucceededSessions.clear();
        bridgeContext.pendingSendToolCalls.clear();
        bridgeContext.v2TurnStartAt.clear();
        bridgeContext.toolCallNames.clear();
        bridgeContext.pendingWakeKeys.clear();
        bridgeContext.clearAllPendingWakeLeases();
        bridgeContext.social.exitingSessions.clear();
        bridgeContext.wakeConfigUpdatedKeys.clear();
        bridgeContext.markReadCalledKeys.clear();
        bridgeContext.wakeConfigMissCount.clear();
      }
      await bridgeContext.sleep(3000);
    }
  }
