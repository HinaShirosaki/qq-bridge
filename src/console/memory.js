import { buildSlangContext, createSlangEntry, mergeEvidence, SLANG_STATUS } from "../slang-learner.js";

export async function handleMemoryRoutes(bridgeContext, env) {
if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/memory-update') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = bridgeContext.redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? bridgeContext.redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => bridgeContext.redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { env.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { env.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !target) { env.sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return true; }
          if (category !== 'memberImpression' && !oldContent) { env.sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('memory')) { env.sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { env.sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { env.sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { env.sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { env.sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          bridgeContext.saveSocialV2State();
          env.sendJson({ ok: true, key, category, memory: bridgeContext.formatMemoryV2(st) });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/memory') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const category = String(env.url.searchParams.get('category') ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('memory')) { env.sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          env.sendJson({ ok: true, key, category, formatted: bridgeContext.formatMemoryV2({ ...st, ...raw }), raw });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/memory-remove') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { env.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { env.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (category === 'memberImpression' && !target) { env.sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return true; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { env.sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
          if (category !== 'memberImpression' && !content) { env.sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('memory')) { env.sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          bridgeContext.saveSocialV2State();
          env.sendJson({ ok: true, key, category, memory: bridgeContext.formatMemoryV2(st) });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/memory-clear') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { env.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('memory')) { env.sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; }
          const st = bridgeContext.getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          bridgeContext.saveSocialV2State();
          env.sendJson({ ok: true, key, category: category || 'all', memory: bridgeContext.formatMemoryV2(st) });
          return true;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/socialV2/slang/query') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const q = String(env.url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('slangQuery')) { env.sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; }
          const list = bridgeContext.confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          env.sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(bridgeContext.slangEntries, bridgeContext.cfg.slang?.injectMax ?? 8)
          });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/socialV2/slang/submit') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = bridgeContext.redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = bridgeContext.redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          if (env.req.headers['x-agent-token'] && !env.agentTokenOk(key, env.req.headers['x-agent-token'])) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2SessionAllowed(key)) { env.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
          if (env.req.headers['x-agent-token'] && !env.v2ToolEnabled('slangSubmit')) { env.sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
          if (bridgeContext.cfg.slang?.enabled === false) { env.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
          if (!content) { env.sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
          if (content.length > 50) { env.sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
          if (!bridgeContext.allowSlangSubmit(key)) { env.sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; }
          const existing = bridgeContext.slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              env.sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: bridgeContext.publicSlangEntry(existing) });
              return true;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              env.sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return true;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            bridgeContext.saveSlangStore();
            if (bridgeContext.cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(bridgeContext.cfg.slang?.inferenceThresholds) ? bridgeContext.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                bridgeContext.queueSlangTask(() => bridgeContext.runSlangResearch([existing]));
              }
            }
            bridgeContext.log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            env.sendJson({ ok: true, duplicate: true, status: 'candidate', entry: bridgeContext.publicSlangEntry(existing) });
            return true;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          bridgeContext.slangEntries.push(entry);
          bridgeContext.saveSlangStore();
          if (bridgeContext.cfg.slang?.autoResearch !== false) {
            bridgeContext.queueSlangTask(() => bridgeContext.runSlangResearch([entry]));
          }
          bridgeContext.log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          bridgeContext.appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          env.sendJson({ ok: true, entry: bridgeContext.publicSlangEntry(entry) });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/authorize/read') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          if (bridgeContext.currentMode === 'reserved2' && !env.agentTokenOk(key, token)) {
            env.sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
            return true;
          }
          if (token && !env.agentTokenOk(key, token)) { env.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return true;
          }
          env.sendJson({ ok: true, key });
          return true;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/images/message') {
          const key = String(env.url.searchParams.get('key') ?? '').trim();
          const messageId = String(env.url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(env.req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
          if (!messageId) { env.sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return true; }
          if (bridgeContext.currentMode === 'reserved2' && !agentToken) {
            env.sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return true;
          }
          if (bridgeContext.currentMode === 'chat' || bridgeContext.currentMode === 'reserved') {
            env.sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return true;
          }
          if (agentToken && !env.agentTokenOk(key, agentToken)) {
            env.sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return true;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return true;
          }
          if (agentToken && !env.v2ToolEnabled('getImages')) {
            env.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return true;
          }
          if (!agentToken && bridgeContext.currentMode === 'closed-agent' && !env.v2ToolEnabled('getImages')) {
            env.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return true;
          }
          const media = bridgeContext.findMessageMedia(key, messageId);
          if (!media.length) {
            env.sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return true;
          }
          try {
            const images = await bridgeContext.fetchMediaData(media);
            env.sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            bridgeContext.log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            env.sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return true;
        }
return false;
}
