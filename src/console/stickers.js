import fs from 'node:fs';

import path from 'node:path';

import { safeFetchBuffer } from "../safe-fetch.js";

import { formatStickerList } from "../sticker-lib.js";

export async function handleStickerRoutes(bridgeContext, env) {
if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/send-poke') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (bridgeContext.currentMode !== 'reserved2') { env.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
          if (!env.req.headers['x-agent-token']) { env.sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; }
          if (!env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (!env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (!env.v2ToolEnabled('sendPoke')) { env.sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; }
          if (bridgeContext.socialV2.paused) { env.sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return true;
          }
          if (bridgeContext.shouldBlockSilentReply(key)) { env.sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; }
          if (kind === 'group' && !targetUserId) {
            env.sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return true;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            env.sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return true;
          }
          const st = bridgeContext.getSocialV2State(key);
          const sendCfg = bridgeContext.cfg.socialV2?.send ?? {};
          const now = Date.now();
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
          try {
            if (kind === 'group') {
              await bridgeContext.bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bridgeContext.bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(bridgeContext.cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            bridgeContext.appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            env.sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            bridgeContext.log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            env.sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/sticker-image') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const stickerId = String(env.url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { env.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getStickerImage')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; }
          try {
            const entry = await bridgeContext.getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, bridgeContext.MAX_MEDIA_BYTES);
            const dims = bridgeContext.getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > bridgeContext.MAX_MEDIA_PIXELS) {
              env.sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return true;
            }
            const mimeType = bridgeContext.mimeFromBuffer(fetched.buffer) || bridgeContext.mimeFromUrl(entry.url);
            env.sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            env.sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/self-image') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getSelfImage')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return true; }
          const selfPath = path.join(bridgeContext.ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { env.sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return true; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = bridgeContext.mimeFromBuffer(buf) || 'image/png';
            env.sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            env.sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/sticker-note') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { env.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('stickerNote')) { env.sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = bridgeContext.applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { env.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
          bridgeContext.log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          env.sendJson({ ok: true, key, sticker: entry });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/sticker-remark') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { env.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('setStickerRemark')) { env.sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; }
          try {
            const entry = await bridgeContext.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            bridgeContext.log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            env.sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            env.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/send-sticker') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { env.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            env.sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return true;
          }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('sendSticker')) { env.sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return true; }
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
          if (kind === 'private' && atUserId) { env.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
          if (bridgeContext.shouldBlockSilentReply(key)) { env.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
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
          const now = Date.now();
          try {
            const st = bridgeContext.getSocialV2State(key);
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
            const sent = await bridgeContext.sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(bridgeContext.cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            bridgeContext.saveSocialV2State();
            bridgeContext.scheduleReplyCheckV2(key);
            bridgeContext.log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            bridgeContext.appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            env.sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = bridgeContext.getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            env.sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/collect-sticker') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { env.sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('collectSticker')) { env.sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const collectCfg = bridgeContext.cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { env.sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            env.sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return true;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await bridgeContext.collectStickerV2(key, messageRef, remark);
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            bridgeContext.appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            env.sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            bridgeContext.saveSocialV2State();
            bridgeContext.log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            env.sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/sticker-list') {
          if (!bridgeContext.stickerEnabled()) { env.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const query = String(env.url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(bridgeContext.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(env.url.searchParams.get('count')) || 48, maxCount)));
          let force = env.url.searchParams.get('refresh') === '1' || env.url.searchParams.get('refresh') === 'true';
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('listStickers')) { env.sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (env.req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - bridgeContext.lastForcedAgentStickerSync < 10000) force = false;
            else bridgeContext.lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await bridgeContext.syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? bridgeContext.stickerEntries, query, count);
            env.sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? bridgeContext.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            env.sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
return false;
}
