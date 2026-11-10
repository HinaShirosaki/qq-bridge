import { SENSITIVE_RE } from "../sensitive.js";

export async function handleMessageSendRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of bridgeContext.socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          env.sendJson({ ok: true, conversations: list });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/wake') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (bridgeContext.currentMode !== 'reserved2') { env.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true;
          }
          const st = bridgeContext.getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          bridgeContext.saveSocialV2State();
          bridgeContext.sendWakePromptV2(key, reason);
          bridgeContext.log(`控制台：手动唤醒 ${key}（${reason}）`);
          env.sendJson({ ok: true, key, reason });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/send-burst') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            env.sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return true;
          }
          if (!key || !messages.length) {
            env.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return true;
          }
          const sendCfgBurst = bridgeContext.cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            env.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return true;
          }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('sendBurst')) { env.sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return true; }
          if (bridgeContext.currentMode !== 'reserved2') {
            env.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return true;
          }
          if (!env.req.headers['x-agent-token']) { env.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return true;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true;
          }
          if (bridgeContext.shouldBlockSilentReply(key)) {
            env.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return true;
          }
          const sendCfg = bridgeContext.cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            env.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return true;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              env.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return true;
            }
            if (SENSITIVE_RE.test(msg)) {
              env.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return true;
            }
          }
          const st = bridgeContext.getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              env.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return true;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = bridgeContext.computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await bridgeContext.sendMessagesV2(key, messages, delays);
            bridgeContext.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            bridgeContext.appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) bridgeContext.scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = bridgeContext.findCjkSpaceWarning(messages);
            const splitWarn = bridgeContext.findSplitBoundaryWarning(messages);
            env.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              bridgeContext.recordSentMessagesV2(key, error.sent);
              bridgeContext.log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
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
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/send-message') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
          const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            env.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return true;
          }
          const sendCfgBurst = bridgeContext.cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            env.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return true;
          }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('sendMessage')) { env.sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return true; }
          if (bridgeContext.currentMode !== 'reserved2') { env.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
          if (!env.req.headers['x-agent-token']) { env.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true;
          }
          if (kind === 'private' && atUserId) {
            env.sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return true;
          }
          if (bridgeContext.shouldBlockSilentReply(key)) {
            env.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return true;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            env.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return true;
          }
          const sendCfg = bridgeContext.cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            env.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return true;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              env.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return true;
            }
            if (SENSITIVE_RE.test(msg)) {
              env.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return true;
            }
          }
          const delays = bridgeContext.computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = bridgeContext.getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            env.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return true;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await bridgeContext.resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              bridgeContext.saveSocialV2State();
              env.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return true;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await bridgeContext.sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            bridgeContext.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            bridgeContext.appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) bridgeContext.scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = bridgeContext.findCjkSpaceWarning(messages);
            const splitWarn = bridgeContext.findSplitBoundaryWarning(messages);
            env.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              bridgeContext.recordSentMessagesV2(key, error.sent);
              bridgeContext.log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
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
return false;
}
