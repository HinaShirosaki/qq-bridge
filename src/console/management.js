import fs from 'node:fs';

import path from 'node:path';

import { unwrap } from "../dsh-client.js";

import { createSlangEntry, SLANG_STATUS } from "../slang-learner.js";

export async function handleGeneralRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/reply-route/authorize') {
          const key = String(env.url.searchParams.get('key') || '');
          const routeId = String(env.url.searchParams.get('routeId') || '');
          let ok = false;
          try {
            if (typeof bridgeContext.api.replyRouteOwnsCodex === 'function') ok = bridgeContext.api.replyRouteOwnsCodex(key, routeId) === true;
          } catch (error) {
            bridgeContext.log(`[reply-route] authorize 异常: ${error?.message ?? error}`);
          }
          env.sendJson({ ok });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/status') {
          const rs = bridgeContext.readRoleState();
          env.sendJson({
            mode: bridgeContext.currentMode,
            replyBackend: bridgeContext.cfg.replyBackend,
            replyRoute: bridgeContext.api.replyRouteStatus?.() ?? { backend: bridgeContext.cfg.replyBackend },
            closedAgentPreset: bridgeContext.closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady: bridgeContext.dshReady,
            ownerQQ: bridgeContext.cfg.ownerQQ ?? null,
            allowGroups: bridgeContext.cfg.allow?.groups ?? [],
            allowPrivate: bridgeContext.cfg.allow?.private ?? [],
            socialV2Paused: bridgeContext.socialV2.paused,
            activity: bridgeContext.readActivityTail(100)
          });
          return true;
        }
        if (env.req.method === 'GET' && env.url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await bridgeContext.api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          env.sendJson({ presets });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/mode') {
          const body = await env.readBody();
          if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
            env.sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
            return true;
          }
          const existing = bridgeContext.readJsonSafe(path.join(bridgeContext.STATE_DIR, 'mode.json'), {});
          const next = {
            mode: body.mode,
            ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
          };
          bridgeContext.atomicWriteJson(path.join(bridgeContext.STATE_DIR, 'mode.json'), next);
          if (next.closedAgentPreset) bridgeContext.closedAgentPreset = next.closedAgentPreset;
          if (bridgeContext.currentMode === 'reserved' && body.mode !== 'reserved') {
            bridgeContext.cleanupSocialForModeChange();
            bridgeContext.log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (bridgeContext.currentMode === 'reserved2' && body.mode !== 'reserved2') {
            bridgeContext.clearAllSocialV2Timers();
            bridgeContext.drainAllPromptQueues('模式切换，已取消排队中的投递');
            bridgeContext.log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          bridgeContext.currentMode = body.mode;
          bridgeContext.lastMode = body.mode;
          if (body.mode === 'reserved2') {
            for (const key of bridgeContext.socialV2.conversations.keys()) {
              bridgeContext.setupSleepTimerV2(key);
              bridgeContext.scheduleProactiveCheckV2(key);
            }
            bridgeContext.log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          bridgeContext.log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
          env.sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/role') {
          const body = await env.readBody();
          const rs = bridgeContext.readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = bridgeContext.sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(bridgeContext.ROOT, 'roles', name + '.md'))) {
              env.sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return true;
            }
            bridgeContext.writeRoleState(name, rs.mode);
            bridgeContext.log(`控制台：角色已设置为 ${name}`);
            env.sendJson({ ok: true, role: name });
          } else {
            bridgeContext.writeRoleState(null, rs.mode);
            bridgeContext.log('控制台：角色已清除');
            env.sendJson({ ok: true, role: null });
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/role-mode') {
          const body = await env.readBody();
          const rs = bridgeContext.readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          bridgeContext.writeRoleState(rs.role, mode);
          bridgeContext.log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          env.sendJson({ ok: true, roleMode: mode });
          return true;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (env.req.method === 'GET' && env.url.pathname === '/api/roles') {
          const rs = bridgeContext.readRoleState();
          env.sendJson({ roles: bridgeContext.listRoles(), current: rs.role ?? null });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/roles/create') {
          const body = await env.readBody();
          const name = bridgeContext.sanitizeRoleName(body.name);
          const content = String(body.content ?? '').trim();
          if (!name) { env.sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return true; }
          if (!content) { env.sendJson({ ok: false, error: '角色内容不能为空' }, 400); return true; }
          if (name === 'README') { env.sendJson({ ok: false, error: '该名称被保留' }, 400); return true; }
          const roleFile = path.join(bridgeContext.ROOT, 'roles', name + '.md');
          if (fs.existsSync(roleFile)) { env.sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return true; }
          fs.mkdirSync(path.join(bridgeContext.ROOT, 'roles'), { recursive: true });
          bridgeContext.atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
          bridgeContext.log(`控制台：创建人格「${name}」`);
          env.sendJson({ ok: true, role: name });
          return true;
        }
return false;
}

export async function handleSlangRoutes(bridgeContext, env) {
if (env.req.method === 'GET' && env.url.pathname === '/api/slang') {
          const status = env.url.searchParams.get('status') || '';
          const list = status ? bridgeContext.slangEntries.filter((e) => e.status === status) : bridgeContext.slangEntries;
          env.sendJson({ entries: list, config: bridgeContext.cfg.slang });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang') {
          const body = await env.readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { env.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
          if (bridgeContext.slangEntries.some((e) => e.content === content)) { env.sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return true; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          bridgeContext.slangEntries.push(entry);
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：新增黑话「${content}」`);
          env.sendJson({ ok: true, entry });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/clear') {
          const body = await env.readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            env.sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return true;
          }
          let removedCount = 0;
          if (status) {
            removedCount = bridgeContext.slangEntries.filter((e) => e.status === status).length;
            bridgeContext.slangEntries = bridgeContext.slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = bridgeContext.slangEntries.length;
            bridgeContext.slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            bridgeContext.slangWindows.clear();
            bridgeContext.slangExtractionCooldowns.clear();
            bridgeContext.slangSubmitTimes.clear();
            bridgeContext.slangResearchingIds.clear();
          }
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          env.sendJson({ ok: true, removedCount });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/batch-delete') {
          const body = await env.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = bridgeContext.slangEntries.length;
            bridgeContext.slangEntries = bridgeContext.slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - bridgeContext.slangEntries.length;
            if (!removedCount) { env.sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return true; }
            bridgeContext.saveSlangStore();
            bridgeContext.log(`控制台：批量删除黑话 ${removedCount} 条`);
            env.sendJson({ ok: true, removedCount });
            return true;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            env.sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return true;
          }
          if (!status) { env.sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return true; }
          const removedCount = bridgeContext.slangEntries.filter((e) => e.status === status).length;
          bridgeContext.slangEntries = bridgeContext.slangEntries.filter((e) => e.status !== status);
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          env.sendJson({ ok: true, removedCount });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/batch-confirm') {
          const body = await env.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { env.sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return true; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = bridgeContext.slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          env.sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/batch-reject') {
          const body = await env.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { env.sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return true; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = bridgeContext.slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          env.sendJson({ ok: true, rejectedCount });
          return true;
        }
        const slangMatch = env.url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (env.req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { env.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
          const body = await env.readBody();
          const entry = { ...bridgeContext.slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && bridgeContext.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            env.sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return true;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { env.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
          entry.updatedAt = new Date().toISOString();
          bridgeContext.slangEntries[idx] = entry;
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：更新黑话「${entry.content}」`);
          env.sendJson({ ok: true, entry });
          return true;
        }
        if (env.req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { env.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
          const body = await env.readBody();
          const entry = bridgeContext.slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            env.sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return true;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：确认黑话「${entry.content}」`);
          env.sendJson({ ok: true, entry });
          return true;
        }
        if (env.req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { env.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
          const entry = bridgeContext.slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：拒绝黑话「${entry.content}」`);
          env.sendJson({ ok: true, entry });
          return true;
        }
        if (env.req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = bridgeContext.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { env.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
          const [removed] = bridgeContext.slangEntries.splice(idx, 1);
          bridgeContext.saveSlangStore();
          bridgeContext.log(`控制台：删除黑话「${removed.content}」`);
          env.sendJson({ ok: true, removed });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/extract') {
          if (bridgeContext.cfg.slang?.enabled === false) { env.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
          const body = await env.readBody();
          const key = String(body.key ?? '').trim();
          if (key && bridgeContext.slangWindows.has(key)) {
            bridgeContext.queueSlangTask(() => bridgeContext.runSlangExtraction(key));
            env.sendJson({ ok: true, key });
          } else {
            const firstKey = bridgeContext.slangWindows.keys().next().value;
            if (!firstKey) { env.sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return true; }
            bridgeContext.queueSlangTask(() => bridgeContext.runSlangExtraction(firstKey));
            env.sendJson({ ok: true, key: firstKey });
          }
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/research') {
          if (bridgeContext.cfg.slang?.enabled === false) { env.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
          const body = await env.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? bridgeContext.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : bridgeContext.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { env.sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return true; }
          bridgeContext.queueSlangTask(() => bridgeContext.runSlangResearch(candidates));
          env.sendJson({ ok: true, count: candidates.length });
          return true;
        }
        if (env.req.method === 'POST' && env.url.pathname === '/api/slang/config') {
          const body = await env.readBody();
          const oldPreset = bridgeContext.cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = bridgeContext.cfg.slang?.workspaceTitle;
          const configFile = path.join(bridgeContext.ROOT, 'config.json');
          const file = bridgeContext.readJsonSafe(configFile, null, true);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          bridgeContext.atomicWriteJson(configFile, file);
          bridgeContext.cfg.slang = { ...bridgeContext.cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            bridgeContext.invalidateSlangLearnerSession();
            bridgeContext.log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            bridgeContext.invalidateSlangLearnerSession();
            bridgeContext.log('黑话学习工作区名已变更，已重置学习会话');
          }
          bridgeContext.log('控制台：黑话系统配置已更新');
          env.sendJson({ ok: true, config: bridgeContext.cfg.slang });
          return true;
        }
return false;
}
