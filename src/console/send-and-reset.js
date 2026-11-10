import fs from 'node:fs';

import { unwrap } from "../dsh-client.js";

import { SENSITIVE_RE } from "../sensitive.js";

export async function handleSendAndResetRoutes(bridgeContext, env) {
if (env.req.method === 'POST' && (env.url.pathname === '/api/send/group' || env.url.pathname === '/api/send/private' || env.url.pathname === '/api/send/reply')) {
          const body = await env.readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = env.url.pathname === '/api/send/private';
          const isReply = env.url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = bridgeContext.unquoteJsonString(String(body.message ?? '').trim());
          const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (bridgeContext.currentMode === 'chat' || bridgeContext.currentMode === 'reserved') {
            env.sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return true;
          }
          if (bridgeContext.socialV2.paused && token) {
            env.sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return true;
          }
          if (!targetId || !message) { env.sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; }
          if (isPrivate && atUserId) { env.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            env.sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return true;
          }
          if (bridgeContext.currentMode === 'reserved2' && !token) { env.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
          if (token && !env.agentTokenOk(key, token)) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !env.v2ToolEnabled(flag)) { env.sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; }
          if (bridgeContext.shouldBlockSilentReply(key)) {
            env.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return true;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            env.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return true;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = bridgeContext.getSocialV2State(key);
            const resolved = await bridgeContext.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              env.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return true;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = bridgeContext.cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { env.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return true; }
          if (SENSITIVE_RE.test(message)) { env.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              env.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return true;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await bridgeContext.sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            bridgeContext.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[send] ${env.url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            bridgeContext.appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) bridgeContext.scheduleReplyCheckV2(key);
            env.sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              bridgeContext.recordSentMessagesV2(key, error.sent);
              bridgeContext.log(`[send] ${env.url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            bridgeContext.saveSocialV2State();
            env.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return true;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (env.req.method === 'POST' && env.url.pathname === '/api/session/reset') {
          const body = await env.readBody();
          const key = String(body.key ?? '');
          if (!key || !bridgeContext.state.sessions[key]) { env.sendJson({ ok: false, error: '会话不存在' }, 404); return true; }
          bridgeContext.sessionEpoch++;
          const oldSessionId = bridgeContext.state.sessions[key];
          delete bridgeContext.state.sessions[key];
          bridgeContext.reverse.delete(oldSessionId);
          bridgeContext.collectors.delete(oldSessionId);
          bridgeContext.sendToolSucceededSessions.delete(oldSessionId);
          bridgeContext.pendingSendToolCalls.delete(oldSessionId);
          bridgeContext.v2TurnStartAt.delete(oldSessionId);
          bridgeContext.toolCallNames.delete(oldSessionId);
          const pe = bridgeContext.pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            bridgeContext.cancelPendingEntry(pe).catch(() => {});
          }
          bridgeContext.pending.delete(key);
          bridgeContext.queued.delete(key);
          bridgeContext.queuedHintAt.delete(key);
          bridgeContext.sessionPromises.delete(key);
          bridgeContext.drainPromptQueue(key, '会话已重置');
          bridgeContext.social.recentMessages.delete(key);
          bridgeContext.messageMediaStore.delete(key);
          bridgeContext.social.pendingSummaries.delete(key);
          bridgeContext.social.states.delete(key);
          bridgeContext.social.silentContext.delete(key);
          bridgeContext.social.silentTurns.delete(oldSessionId);
          bridgeContext.social.exitingSessions.delete(oldSessionId);
          bridgeContext.slangWindows.delete(key);
          bridgeContext.slangExtractionCooldowns.delete(key);
          bridgeContext.slangSubmitTimes.delete(key);
          bridgeContext.cancelSocialTimers(key);
          bridgeContext.clearSocialV2Timers(key);
          bridgeContext.pendingWakeKeys.delete(key);
          bridgeContext.wakeConfigUpdatedKeys.delete(key);
          bridgeContext.markReadCalledKeys.delete(key);
          bridgeContext.wakeConfigMissCount.delete(key);
          const removedV2 = bridgeContext.socialV2.conversations.get(key);
          if (removedV2?.agentToken) bridgeContext.KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          bridgeContext.socialV2.conversations.delete(key);
          bridgeContext.seenForwardIds.delete(key);
          bridgeContext.saveSocialV2State();
          bridgeContext.saveState();
          try { await bridgeContext.api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          bridgeContext.log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
          env.sendJson({ ok: true, key, archived: oldSessionId });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/workspace/reset') {
          bridgeContext.sessionEpoch++;
          let archivedCount = 0;
          try {
            const ws = unwrap(await bridgeContext.api.workspace.list({}), 'workspace.list');
            const qq = ws.items.find((w) => w.title === bridgeContext.cfg.workspaceTitle);
            if (qq) {
              for (const sid of qq.sessionIds) {
                try { await bridgeContext.api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch {}
              }
              try { await bridgeContext.api.workspace.delete({ workspaceId: qq.workspaceId }); } catch {}
            }
          } catch {}
          for (const entry of bridgeContext.pending.values()) {
            clearTimeout(entry.timer);
            bridgeContext.cancelPendingEntry(entry).catch(() => {});
          }
          bridgeContext.pending.clear();
          bridgeContext.queued.clear();
          bridgeContext.queuedHintAt.clear();
          bridgeContext.sessionPromises.clear();
          bridgeContext.drainAllPromptQueues('工作区已清空');
          bridgeContext.social.states.clear();
          bridgeContext.social.recentMessages.clear();
          bridgeContext.messageMediaStore.clear();
          bridgeContext.seenForwardIds.clear();
          bridgeContext.social.pendingSummaries.clear();
          bridgeContext.social.silentContext.clear();
          bridgeContext.social.silentTurns.clear();
          bridgeContext.social.exitingSessions.clear();
          bridgeContext.slangWindows.clear();
          bridgeContext.slangExtractionCooldowns.clear();
          bridgeContext.slangSubmitTimes.clear();
          bridgeContext.cancelAllSocialTimers();
          bridgeContext.clearAllSocialV2Timers();
          for (const st of bridgeContext.socialV2.conversations.values()) {
            if (st?.agentToken) bridgeContext.KNOWN_AGENT_TOKENS.delete(st.agentToken);
          }
          bridgeContext.socialV2.conversations.clear();
          bridgeContext.saveSocialV2State();
          bridgeContext.state.sessions = {};
          bridgeContext.reverse.clear();
          bridgeContext.collectors.clear();
          bridgeContext.sendToolSucceededSessions.clear();
          bridgeContext.pendingSendToolCalls.clear();
          bridgeContext.v2TurnStartAt.clear();
          bridgeContext.toolCallNames.clear();
          bridgeContext.saveState();
          try { fs.writeFileSync(bridgeContext.ACTIVITY_LOG, ''); } catch {}
          bridgeContext.log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          env.sendJson({ ok: true, archivedCount });
          return true;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (env.req.method === 'POST' && env.url.pathname === '/api/restart') {
          env.sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            bridgeContext.log('控制台：重启桥接');
            bridgeContext.releaseLock();
            process.exit(0);
          }, 500);
          return true;
        }
return false;
}
