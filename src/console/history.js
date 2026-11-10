import fs from 'node:fs';

import { formatForwardResponse } from "../forward.js";

export async function handleHistoryRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(env.url.searchParams.get('limit')) || 200));
          env.sendJson({ ok: true, entries: bridgeContext.readToolLog(limit) });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/tool-log/clear') {
          if (env.req.headers['x-agent-token']) { env.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          try { fs.writeFileSync(bridgeContext.TOOL_LOG_FILE, '', 'utf8'); } catch {}
          bridgeContext.log('控制台：工具调用日志已清空');
          env.sendJson({ ok: true });
          return true;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/feedback') {
          env.sendJson({ ok: true, entries: bridgeContext.readFeedbackEntries() });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/feedback-clear') {
          if (env.req.headers['x-agent-token']) { env.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
          bridgeContext.atomicWriteJson(bridgeContext.FEEDBACK_FILE, []);
          bridgeContext.log('控制台：清空 AI 反馈');
          env.sendJson({ ok: true });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/feedback') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { env.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('feedback')) { env.sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = bridgeContext.feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            env.sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return true;
          }
          fTimes.push(fNow);
          bridgeContext.feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(bridgeContext.cfg.socialV2?.feedback?.maxLength) || 500);
          const message = rawMessage.slice(0, maxLength);
          bridgeContext.appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          bridgeContext.log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          bridgeContext.appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (bridgeContext.cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && bridgeContext.cfg.ownerQQ) {
            bridgeContext.log(`[reserved2] 错误级反馈，可通知 owner ${bridgeContext.cfg.ownerQQ}（当前仅记录日志）`);
          }
          env.sendJson({ ok: true, key, level, message });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/my-recent') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(env.url.searchParams.get('limit')) || 10));
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getMyRecent')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          env.sendJson({ ok: true, key, messages: mine });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          env.sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/message-detail') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const messageId = String(env.url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { env.sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getMessageDetail')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = bridgeContext.getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await bridgeContext.resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            env.sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            env.sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/forward-message') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const id = String(env.url.searchParams.get('id') ?? '').trim();
          const agentToken = String(env.req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          if (!id) { env.sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
          if (bridgeContext.currentMode !== 'reserved2') {
            env.sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return true;
          }
          if (!agentToken) {
            env.sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return true;
          }
          if (!env.agentTokenOk(key, agentToken)) {
            env.sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return true;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !bridgeContext.modeAllowed(key, kind, num, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return true;
          }
          if (!env.v2ToolEnabled('getForwardMsg')) {
            env.sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return true;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = bridgeContext.getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = bridgeContext.seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            env.sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return true;
          }
          try {
            const data = await bridgeContext.bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = bridgeContext.seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                bridgeContext.seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bridgeContext.bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                bridgeContext.log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            env.sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            bridgeContext.log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            env.sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/forward-media') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getForwardMsg')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return true; }
          if (bridgeContext.currentMode !== 'reserved2') { env.sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return true; }
          if (!media.length) { env.sendJson({ ok: true, key, media: [], images: [] }); return true; }
          try {
            const images = await bridgeContext.fetchMediaData(media);
            env.sendJson({ ok: true, key, media, images });
          } catch (error) {
            bridgeContext.log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            env.sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/active-members') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(env.url.searchParams.get('limit')) || 10));
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getActiveMembers')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          env.sendJson({ ok: true, key, members });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/memory-append') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { env.sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { env.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { env.sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('memory')) { env.sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          bridgeContext.appendMemoryV2(st, category, content, extra);
          env.sendJson({ ok: true, key, category, content, memory: bridgeContext.formatMemoryV2(st) });
          return true;
        }
return false;
}
