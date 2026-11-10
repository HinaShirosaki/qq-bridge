import { looksLikeUnfinished } from "../v2-wait.js";

import { formatStickerList } from "../sticker-lib.js";

export async function handleWaitRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/stickers') {
          const query = String(env.url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(bridgeContext.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(env.url.searchParams.get('count')) || 48, maxCount)));
          const force = env.url.searchParams.get('refresh') === '1' || env.url.searchParams.get('refresh') === 'true';
          try {
            const synced = await bridgeContext.syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? bridgeContext.stickerEntries, query, count);
            env.sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? bridgeContext.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            env.sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/stickers/sync') {
          try {
            const synced = await bridgeContext.syncStickerLibrary(true);
            env.sendJson({ ok: true, total: synced?.entries?.length ?? bridgeContext.stickerEntries.length, syncedAt: synced?.syncedAt ?? bridgeContext.stickerSyncedAt });
          } catch (error) {
            env.sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/stickers/note') {
          const body = await env.readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { env.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
          const entry = bridgeContext.applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { env.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
          env.sendJson({ ok: true, sticker: entry });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/stickers/remark') {
          const body = await env.readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { env.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
          try {
            const entry = await bridgeContext.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            env.sendJson({ ok: true, sticker: entry });
          } catch (error) {
            env.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/wait') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('waitMessages')) { env.sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return true; }
          if (bridgeContext.socialV2.paused) {
            const st = bridgeContext.getSocialV2State(key);
            env.sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
            return true;
          }
          const waitCfg = bridgeContext.cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = bridgeContext.getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          if (bridgeContext.activeWaits.has(key)) {
            env.sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return true;
          }
          bridgeContext.activeWaits.add(key);
          bridgeContext.activeWaitSince.set(key, Date.now());
          let aborted = false;
          const finishWait = () => { bridgeContext.activeWaits.delete(key); bridgeContext.activeWaitSince.delete(key); };
          // 【本地补丁】只监听 req 的 close 不够：客户端（DSH/MCP）中止请求时，
          // IncomingMessage 的 'close' 未必触发，导致 activeWaits 永久占用、后续每次
          // qq_wait_for_messages 都吃 429「已有一个等待中的」——实测就这样卡了 5 分钟以上。
          // 同时监听 Response 的 close（中止时会触发），并立即把 aborted 置位结束循环。
          const onWaitClose = () => { aborted = true; finishWait(); };
          env.req.on('close', onWaitClose);
          env.req.on('aborted', onWaitClose);
          env.res.on('close', onWaitClose);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(bridgeContext.suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          bridgeContext.cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          const baseline = st.lastUnreadSeq || 0;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          // aborted 与 close 监听已在上方注册
          // 【本地补丁】繁忙群里的 @ 即时打断等待。
          // 原逻辑只等“最后一条新消息之后 quietMs 内无新消息”，但活跃群消息每 1~3 秒一条，
          // 这个窗口永远凑不齐，只能等兜底上限 timeoutMs + maxQuietMs + 5000 才返回
          // （实测 @ 之后约 3 分钟才回复，表现为"@ 没反应"）。
          // 现在：命中 @我 / 引用我 / 私聊消息 就立刻结束等待，把这些消息交给 AI 马上处理。
          const nickLower = typeof bridgeContext.selfNickname === 'string' ? bridgeContext.selfNickname.toLowerCase() : '';
          const isDirectedAtSelf = (m) => {
            if (!m || m.isSelf) return false;
            if (m.atSelf) return true; // 权威：原始事件里的 at 段
            if (m.quoteTargetIsSelf) return true;
            if (key.startsWith('private:')) return true; // 私聊每条消息都是对我说的
            if (!nickLower) return false;
            const t = String(m.text ?? '').toLowerCase();
            return t.includes('@' + nickLower) || t.includes('＠' + nickLower);
          };
          const mentionArrived = () => Array.isArray(st.recentMessages)
            && st.recentMessages.some((m) => (m?.seq || 0) > baseline && isDirectedAtSelf(m));
          let mentionPreempt = false;
          while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                if (mentionArrived()) { mentionPreempt = true; break; }
                await bridgeContext.sleep(200);
              }
              break;
            }
            // 还没凑够 minNewMessages 时也一样：@ 我不该继续干等。
            if (mentionArrived()) { arrived = true; lastNewAt = Date.now(); mentionPreempt = true; break; }
            await bridgeContext.sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (mentionPreempt) bridgeContext.log(`[reserved2] @ 打断等待 ${key}（等了 ${waitedMs}ms，被 ${key.startsWith('private:') ? '私聊消息' : '@我/引用我'} 打断）`); // 【本地补丁】可观测
          const preSleepWaitMs = Math.max(0, Number(bridgeContext.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = bridgeContext.preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          bridgeContext.saveSocialV2State();
          const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          env.sendJson({
            ok: true,
            key,
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            mentionPreempt, // 【本地补丁】是否因@我/引用我/私聊消息而提前结束等待
            lastMessageUnfinished,
            timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !!st.preSleepWaitObservedAt,
            preSleepWaitMs,
            preSleepWaitRemainingMs: preSleepRemainingMs,
            newMessages,
            unreadCount: st.unread.length
          });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/check-send') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            env.sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return true;
          }
          if (!env.agentTokenOk(key, token)) {
            env.sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return true;
          }
          if (!env.v2SessionAllowed(key)) {
            env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            env.sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return true;
          }
          if (!env.v2ToolEnabled(flag)) {
            env.sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return true;
          }
          env.sendJson({ ok: true, key, tool });
          return true;
        }
return false;
}
