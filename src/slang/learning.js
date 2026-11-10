import fs from 'node:fs';

import path from 'node:path';

import { unwrap } from "../dsh-client.js";

import { saveSlang, upsertSlangEntry, buildSlangContext, buildExtractionPrompt, buildResearchPrompt, parseExtractionJson, parseResearchJson, SLANG_STATUS } from "../slang-learner.js";

export function saveSlangStore(bridgeContext) {
    try { saveSlang(bridgeContext.SLANG_FILE, bridgeContext.slangEntries); } catch (error) { bridgeContext.log('保存黑话库失败:', error?.message ?? error); }
  }

export function queueSlangTask(bridgeContext, fn) {
    bridgeContext.slangTaskChain = bridgeContext.slangTaskChain.then(fn).catch((error) => bridgeContext.log('黑话学习任务异常:', error?.message ?? error));
    return bridgeContext.slangTaskChain;
  }

export async function ensureSlangLearnerSession(bridgeContext) {
    if (bridgeContext.slangLearnerSessionId) {
      bridgeContext.learnerSessions.add(bridgeContext.slangLearnerSessionId);
      return bridgeContext.slangLearnerSessionId;
    }
    const saved = bridgeContext.readJsonSafe(bridgeContext.SLANG_SESSION_FILE, null);
    if (saved?.sessionId) {
      bridgeContext.slangLearnerSessionId = String(saved.sessionId);
      bridgeContext.learnerSessions.add(bridgeContext.slangLearnerSessionId);
      return bridgeContext.slangLearnerSessionId;
    }
    const dir = path.join(bridgeContext.STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await bridgeContext.api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = bridgeContext.cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await bridgeContext.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    const preset = bridgeContext.cfg.slang?.learnerPreset || bridgeContext.cfg.agentPreset || undefined;
    if (preset) params.agentPreset = preset;
    const value = unwrap(await bridgeContext.api.sessions.create(params), 'slang session.create');
    bridgeContext.slangLearnerSessionId = value.sessionId;
    bridgeContext.learnerSessions.add(bridgeContext.slangLearnerSessionId);
    fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
    bridgeContext.atomicWriteJson(bridgeContext.SLANG_SESSION_FILE, { sessionId: bridgeContext.slangLearnerSessionId });
    bridgeContext.log(`黑话学习会话已创建：${bridgeContext.slangLearnerSessionId}`);
    return bridgeContext.slangLearnerSessionId;
  }

export function invalidateSlangLearnerSession(bridgeContext) {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = bridgeContext.slangLearnerSessionId;
    bridgeContext.slangLearnerSessionId = null;
    if (oldId && !bridgeContext.learnerWaiters.has(oldId) && !bridgeContext.learnerCollectors.has(oldId)) {
      bridgeContext.learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(bridgeContext.SLANG_SESSION_FILE); } catch {}
  }

export function waitLearnerTurn(bridgeContext, sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = bridgeContext.learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) bridgeContext.learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = bridgeContext.learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      bridgeContext.learnerWaiters.set(sessionId, arr);
    });
  }

export async function runSlangExtraction(bridgeContext, key) {
    if (bridgeContext.cfg.slang?.enabled === false) return;
    if (!bridgeContext.dshReady) return;
    const messages = bridgeContext.slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(bridgeContext.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await bridgeContext.ensureSlangLearnerSession();
    } catch (error) {
      bridgeContext.log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await bridgeContext.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        bridgeContext.log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await bridgeContext.waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        bridgeContext.log(`黑话提取：${key} 未发现候选`);
        const win = bridgeContext.slangWindows.get(key) ?? [];
        bridgeContext.slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(bridgeContext.cfg.slang?.inferenceThresholds) ? bridgeContext.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(bridgeContext.slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = bridgeContext.slangWindows.get(key) ?? [];
      bridgeContext.slangWindows.set(key, win.slice(messages.length));
      bridgeContext.saveSlangStore();
      bridgeContext.log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && bridgeContext.cfg.slang?.autoResearch !== false) {
        bridgeContext.queueSlangTask(() => bridgeContext.runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        bridgeContext.invalidateSlangLearnerSession();
      }
      bridgeContext.log(`黑话提取失败 (${key}):`, error?.message ?? error);
    } finally {
      await retireSlangLearnerSession(bridgeContext, sessionId);
    }
  }

export async function runSlangResearch(bridgeContext, candidates) {
    if (!candidates || !candidates.length) return;
    if (bridgeContext.cfg.slang?.enabled === false) return;
    if (!bridgeContext.dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !bridgeContext.slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) bridgeContext.slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await bridgeContext.ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) bridgeContext.slangResearchingIds.delete(e.id);
      bridgeContext.log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await bridgeContext.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        bridgeContext.log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await bridgeContext.waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = bridgeContext.slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          bridgeContext.log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      bridgeContext.saveSlangStore();
      bridgeContext.log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        bridgeContext.invalidateSlangLearnerSession();
      }
      bridgeContext.log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) bridgeContext.slangResearchingIds.delete(e.id);
      await retireSlangLearnerSession(bridgeContext, sessionId);
    }
  }

// Each learner prompt is self-contained, so a reused session only replays old extractions
// on every new one. Archive it after each task; the next task gets a fresh, short session.
async function retireSlangLearnerSession(bridgeContext, sessionId) {
    if (!sessionId || bridgeContext.cfg.tokenOptimization?.freshLearnerSession === false) return;
    if (bridgeContext.slangLearnerSessionId === sessionId) bridgeContext.invalidateSlangLearnerSession();
    try { await bridgeContext.api.workspace.archiveSession({ sessionId }); } catch {}
  }

export function maybeQueueSlangExtraction(bridgeContext, key) {
    if (bridgeContext.cfg.slang?.enabled === false) return;
    if (!bridgeContext.dshReady) return;
    const cooldown = Number(bridgeContext.cfg.slang?.extractCooldownMs ?? 300000);
    const last = bridgeContext.slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = bridgeContext.slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(bridgeContext.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    bridgeContext.slangExtractionCooldowns.set(key, Date.now());
    bridgeContext.queueSlangTask(() => bridgeContext.runSlangExtraction(key));
  }

export function feedSlangWindow(bridgeContext, key, sender, plainContent) {
    if (bridgeContext.cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!bridgeContext.slangWindows.has(key)) bridgeContext.slangWindows.set(key, []);
    const win = bridgeContext.slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: text.slice(0, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    bridgeContext.maybeQueueSlangExtraction(key);
  }

export function allowSlangSubmit(bridgeContext, key) {
    const now = Date.now();
    const arr = (bridgeContext.slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    bridgeContext.slangSubmitTimes.set(key, arr);
    return true;
  }

export function publicSlangEntry(bridgeContext, e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      evidence: Array.isArray(e?.evidence) ? e.evidence.slice(-5) : [],
      updatedAt: e?.updatedAt ?? ''
    };
  }

export function confirmedSlangListV2(bridgeContext) {
    const max = Math.max(1, Math.min(30, Number(bridgeContext.cfg.slang?.injectMax) || 8));
    return bridgeContext.slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(bridgeContext.publicSlangEntry);
  }

export function withSlangContext(bridgeContext, promptText, { includeSlang = true, compactTime = false } = {}) {
    const now = new Date();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeLine = compactTime
      ? `${now.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} ${zone}`
      : `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${zone}）`;
    const parts = [timeLine];
    if (includeSlang && bridgeContext.cfg.slang?.enabled !== false) {
      const block = buildSlangContext(bridgeContext.slangEntries, bridgeContext.cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    const separator = compactTime ? '\n' : '\n\n';
    return parts.join(separator) + separator + promptText;
  }
