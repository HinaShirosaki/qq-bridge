import { buildSlangContext } from "../slang-learner.js";
import { buildStickerContext, buildStickerStrategyHint } from "../sticker-lib.js";
import { deferPreSleepV2, markReadV2 } from "../social/wake-triggers.js";

export async function handleWakeConfigRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/state') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('socialState')) { env.sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          env.sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: bridgeContext.computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/prompt') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getPrompt')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (bridgeContext.cfg.socialV2?.sticker?.enabled !== false) {
            try { await bridgeContext.syncStickerLibrary(false); } catch {}
          }
          const roleState = bridgeContext.readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image'
          };
          const tools = bridgeContext.cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !bridgeContext.stickerEnabled())) enabledTools.push(name);
          }
          env.sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: bridgeContext.currentMode === 'reserved2' ? bridgeContext.currentRoleHintV2() : bridgeContext.currentRoleHint() },
            recommended: bridgeContext.cfg.socialV2?.provideRecommendations === false ? null : {
              wake: bridgeContext.cfg.socialV2?.wake ?? {},
              send: bridgeContext.cfg.socialV2?.send ?? {},
              wait: bridgeContext.cfg.socialV2?.wait ?? {},
              proactive: bridgeContext.cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: bridgeContext.computeWakeSafetyV2(st.wakeConfig),
            memory: bridgeContext.formatMemoryV2(st),
            participation: bridgeContext.formatParticipationV2(st),
            slang: {
              enabled: bridgeContext.cfg.slang?.enabled !== false,
              entries: bridgeContext.confirmedSlangListV2(),
              block: buildSlangContext(bridgeContext.slangEntries, bridgeContext.cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: bridgeContext.cfg.socialV2?.sticker?.enabled !== false,
              total: bridgeContext.stickerEntries.length,
              context: bridgeContext.cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(bridgeContext.stickerEntries, bridgeContext.cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: bridgeContext.cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            }
          });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/unread') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(env.url.searchParams.get('limit')) || 30));
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getUnread')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          env.sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/recent') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(env.url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(env.url.searchParams.get('offset')) || 0);
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('getRecent')) { env.sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          env.sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/mark-read') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('markRead')) { env.sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          const marked = markReadV2(bridgeContext, key, st, 'mark_read');
          if (!marked) {
            const preSleepMs = Math.max(0, Number(bridgeContext.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            env.sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return true;
          }
          const { markedCount, observeMs } = marked;
          bridgeContext.markReadCalledKeys.add(key);
          bridgeContext.log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          env.sendJson({ ok: true, key, markedCount, ...(observeMs ? { preSleepObservingMs: observeMs } : {}), wakeGuaranteed: bridgeContext.computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: bridgeContext.computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/wake-config') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('setWakeConfig')) { env.sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(bridgeContext.cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(bridgeContext.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(bridgeContext.cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(bridgeContext.cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(bridgeContext.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(bridgeContext.cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = bridgeContext.normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              env.sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return true;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          const sleeping = bridgeContext.isSleepingConfigV2(next);
          const mustObserve = sleeping && bridgeContext.preSleepWaitBlockedV2(st);
          const observeMs = sleeping ? deferPreSleepV2(bridgeContext, st, mustObserve) : 0;
          if (mustObserve && !observeMs) {
            const preSleepMs = Math.max(0, Number(bridgeContext.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            env.sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return true;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          bridgeContext.saveSocialV2State();
          bridgeContext.wakeConfigUpdatedKeys.add(key);
          bridgeContext.wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          bridgeContext.cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          bridgeContext.setupSleepTimerV2(key);
          bridgeContext.log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          env.sendJson({ ok: true, key, ...(observeMs ? { preSleepObservingMs: observeMs } : {}), wakeConfig: next, wakeSafety: bridgeContext.computeWakeSafetyV2(next) });
          return true;
        }
return false;
}
