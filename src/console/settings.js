import path from 'node:path';
import crypto from 'node:crypto';

import { text } from '@snowluma/sdk';

import { SENSITIVE_RE } from "../sensitive.js";
import { normalizeOwnerQQ } from "../bridge/config.js";

export async function handleSettingsRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(bridgeContext.state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(bridgeContext.cfg.ownerQQ ?? '')}` });
          }
          env.sendJson({ sessions: list });
          return true;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of bridgeContext.pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          env.sendJson({ pending: list });
          return true;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/whitelist') {
          env.sendJson({ allow: bridgeContext.cfg.allow ?? { private: [], groups: [] }, deny: bridgeContext.cfg.deny ?? { private: [], groups: [] }, ownerQQ: bridgeContext.cfg.ownerQQ ?? null });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/whitelist') {
          const body = await env.readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(bridgeContext.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = bridgeContext.readJsonSafe(configFile, null, true);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = bridgeContext.cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              env.sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return true;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          bridgeContext.atomicWriteJson(configFile, file);
          bridgeContext.cfg.allow = { private: allow.private, groups: allow.groups };
          bridgeContext.cfg.deny = { private: deny.private, groups: deny.groups };
          bridgeContext.cfg.ownerQQ = ownerQQ;
          bridgeContext.log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          env.sendJson({ ok: true, allow, deny, ownerQQ });
          return true;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/security') {
          env.sendJson({ security: bridgeContext.cfg.security ?? { interceptNotify: true } });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/security') {
          const body = await env.readBody();
          const configFile = path.join(bridgeContext.ROOT, 'config.json');
          const file = bridgeContext.readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          bridgeContext.atomicWriteJson(configFile, file);
          bridgeContext.cfg.security = { ...(bridgeContext.cfg.security ?? {}), ...next };
          bridgeContext.log(`控制台：安全拦截通知已更新（interceptNotify=${bridgeContext.cfg.security.interceptNotify}）`);
          env.sendJson({ ok: true, security: bridgeContext.cfg.security });
          return true;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (env.req.method === 'POST' && env.url.pathname === '/api/console/token') {
          const body = await env.readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            env.sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return true;
          }
          if (newToken.length > 128) {
            env.sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return true;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            env.sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return true;
          }
          const configFile = path.join(bridgeContext.ROOT, 'config.json');
          const file = bridgeContext.readJsonSafe(configFile, null, true);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          bridgeContext.atomicWriteJson(configFile, file);
          bridgeContext.cfg.consoleToken = generated ? '' : newToken;
          bridgeContext.atomicWriteText(path.join(bridgeContext.STATE_DIR, 'console-token'), newToken);
          env.consoleToken = newToken;
          bridgeContext.log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          env.sendJson({ ok: true, token: newToken, generated });
          return true;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (env.req.method === 'POST' && env.url.pathname === '/api/test-send') {
          const body = await env.readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { env.sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
          if (!message) { env.sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
          if (SENSITIVE_RE.test(message)) { env.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
          if (!bridgeContext.allowed(kind, id, bridgeContext.cfg)) { env.sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
          if (!bridgeContext.modeAllowed(`${kind}:${id}`, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) { env.sendJson({ ok: false, error: `当前模式（${bridgeContext.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
          try {
            const safeMessage = bridgeContext.escapeCqText(bridgeContext.redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bridgeContext.bot.sendPrivateMessage(id, text(safeMessage))
              : await bridgeContext.bot.sendGroupMessage(id, text(safeMessage));
            bridgeContext.log(`控制台：测试发送 ${kind}:${id} 成功`);
            env.sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            env.sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/social/state') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { env.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            bridgeContext.enterActive(key);
            bridgeContext.log(`控制台：手动将 ${key} 设为活跃`);
            env.sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            bridgeContext.leaveActive(key);
            bridgeContext.log(`控制台：手动将 ${key} 设为观望`);
            env.sendJson({ ok: true, key, phase: 'idle' });
          } else {
            env.sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return true;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of bridgeContext.social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...bridgeContext.social.states.keys(), ...bridgeContext.social.recentMessages.keys()]);
          for (const k of keys) {
            const st = bridgeContext.social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          env.sendJson({ config: bridgeContext.cfg.social, pendingSummaries: stats, states });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/social') {
          const body = await env.readBody();
          const configFile = path.join(bridgeContext.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = bridgeContext.readJsonSafe(configFile, null, true);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          bridgeContext.atomicWriteJson(configFile, file);
          bridgeContext.cfg.social = { ...bridgeContext.cfg.social, ...merged };
          bridgeContext.log('控制台：社交配置已更新');
          env.sendJson({ ok: true, config: bridgeContext.cfg.social });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/social/flush') {
          const body = await env.readBody();
          await bridgeContext.flushSummaries(body.key || null);
          env.sendJson({ ok: true });
          return true;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (env.req.method === 'POST' && env.url.pathname === '/api/console/notify-ai') {
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            env.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return true;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            env.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return true;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            env.sendJson({ ok: false, error: 'id 无效' }, 400);
            return true;
          }
          if (!bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) {
            env.sendJson({ ok: false, error: `该会话不在当前模式（${bridgeContext.currentMode}）允许范围内` }, 403);
            return true;
          }
          if (!bridgeContext.state.sessions[key] && !bridgeContext.allowed(kind, id, bridgeContext.cfg)) {
            env.sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return true;
          }
          if (!bridgeContext.dshReady) {
            env.sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return true;
          }
          const isV2 = bridgeContext.currentMode === 'reserved2';
          const roleState = bridgeContext.readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = bridgeContext.getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await bridgeContext.ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = bridgeContext.social.silentTurns.get(sessionId) ?? [];
            bridgeContext.social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = bridgeContext.social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) bridgeContext.social.silentTurns.set(sessionId, next);
              else bridgeContext.social.silentTurns.delete(sessionId);
            };
            const result = await bridgeContext.deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              bridgeContext.log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              bridgeContext.appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              env.sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              env.sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            env.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return true;
        }
return false;
}
