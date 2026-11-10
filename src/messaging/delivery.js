import { text } from '@snowluma/sdk';

import { splitForQQ } from "../md-to-plain.js";
import { SENSITIVE_RE } from "../sensitive.js";
import { isPreSleepObservingV2 } from "../social/wake-triggers.js";

export function armPendingWakeLease(bridgeContext, key) {
    const old = bridgeContext.pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      bridgeContext.pendingWakeKeys.delete(key);
      bridgeContext.pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    bridgeContext.pendingWakeLeaseTimers.set(key, timer);
  }

export function disarmPendingWakeLease(bridgeContext, key) {
    const old = bridgeContext.pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    bridgeContext.pendingWakeLeaseTimers.delete(key);
  }

export function clearAllPendingWakeLeases(bridgeContext) {
    for (const t of bridgeContext.pendingWakeLeaseTimers.values()) clearTimeout(t);
    bridgeContext.pendingWakeLeaseTimers.clear();
  }

export async function cancelPendingEntry(bridgeContext, entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await bridgeContext.withTimeout(bridgeContext.api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome: 'rejected' } }
        }), 5000, '取消挂起回执');
        bridgeContext.log(`已取消挂起审批（拒绝回执）: ${entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await bridgeContext.withTimeout(bridgeContext.api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers: [] } } }
        }), 5000, '取消挂起回执');
        bridgeContext.log(`已取消挂起提问（空答案回执）: ${entry.rpcId}`);
      }
    } catch (error) {
      bridgeContext.log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

export async function handlePendingAnswer(bridgeContext, p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await bridgeContext.api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, answer: { answers } } }
        });
        bridgeContext.log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (bridgeContext.pending.get(key) === p) bridgeContext.pending.delete(key);
      } catch (error) {
        bridgeContext.log('回答问题失败（保留挂起以便重试）:', error.message);
        await bridgeContext.sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await bridgeContext.sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of bridgeContext.APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of bridgeContext.REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await bridgeContext.sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await bridgeContext.api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome } }
        });
        bridgeContext.log(`已处理审批 (${key}): ${outcome}`, receipt);
        await bridgeContext.sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (bridgeContext.pending.get(key) === p) bridgeContext.pending.delete(key);
      } catch (error) {
        bridgeContext.log('处理审批失败（保留挂起以便重试）:', error.message);
        await bridgeContext.sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

export async function handlePokeNotice(bridgeContext, event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = bridgeContext.convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = bridgeContext.convKey('private', id);
    }
    if (!bridgeContext.modeAllowed(key, kind, id, bridgeContext.cfg, bridgeContext.currentMode)) return;
    if (bridgeContext.currentMode !== 'reserved2') {
      bridgeContext.appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await bridgeContext.resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(bridgeContext.cfg.ownerQQ ?? '');
    const msg = bridgeContext.appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    bridgeContext.appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (bridgeContext.currentMode !== 'reserved2') return;
    if (bridgeContext.socialV2.paused) return;
    const st = bridgeContext.getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      bridgeContext.saveSocialV2State();
      bridgeContext.scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      bridgeContext.scheduleWakeV2(key, 'poke');
    } else if (isPreSleepObservingV2(st)) {
      bridgeContext.scheduleWakeV2(key, 'preSleepObserve');
    }
  }

export async function registerPending(bridgeContext, key, entry) {
    const existing = bridgeContext.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      bridgeContext.pending.delete(key);
      bridgeContext.log(`新挂起请求覆盖旧请求 (${key})`);
      bridgeContext.cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (bridgeContext.pending.get(key) === entry) {
        bridgeContext.pending.delete(key);
        bridgeContext.log(`挂起请求超时 (${key})`);
        bridgeContext.cancelPendingEntry(entry).catch(() => {});
        bridgeContext.sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, bridgeContext.cfg.questionTimeoutMs);
    entry.timer = timer;
    bridgeContext.pending.set(key, entry);
  }

export function sendToQQ(bridgeContext, key, msg) {
    const safeMsg = bridgeContext.redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    for (const part of parts) {
      bridgeContext.sendChain = bridgeContext.sendChain
        .then(async () => {
          if (kind === 'private') await bridgeContext.withTimeout(bridgeContext.bot.sendPrivateMessage(Number(id), text(bridgeContext.escapeCqText(part))), bridgeContext.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await bridgeContext.withTimeout(bridgeContext.bot.sendGroupMessage(Number(id), text(bridgeContext.escapeCqText(part))), bridgeContext.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => bridgeContext.log(`QQ 发送失败 (${key}):`, error?.message ?? error))
        .then(() => bridgeContext.sleep(bridgeContext.cfg.sendDelayMs));
    }
    return bridgeContext.sendChain;
  }

export function singleLineForQQ(bridgeContext, s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

export function splitLongSegment(bridgeContext, segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

export function planSocialTimeline(bridgeContext, text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: bridgeContext.splitLongSegment(src, maxChars).map(bridgeContext.singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = bridgeContext.splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: bridgeContext.splitLongSegment(parts[0] || src, maxChars).map(bridgeContext.singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...bridgeContext.splitLongSegment(part, maxChars).map(bridgeContext.singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

export function sendBurstToQQ(bridgeContext, key, messages, socialCfgOrMin, maybeMax) {
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = bridgeContext.redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      bridgeContext.sendChain = bridgeContext.sendChain
        .then(async () => {
          if (kind === 'private') await bridgeContext.withTimeout(bridgeContext.bot.sendPrivateMessage(Number(id), text(bridgeContext.escapeCqText(msg))), bridgeContext.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await bridgeContext.withTimeout(bridgeContext.bot.sendGroupMessage(Number(id), text(bridgeContext.escapeCqText(msg))), bridgeContext.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => bridgeContext.log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? bridgeContext.randInt(longMin, longMax) : bridgeContext.randInt(min, max);
        bridgeContext.sendChain = bridgeContext.sendChain.then(() => bridgeContext.sleep(delay));
      }
    }
    return bridgeContext.sendChain.then(() => sent);
  }

export async function onebotSend(bridgeContext, kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...bridgeContext.KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      bridgeContext.log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: bridgeContext.escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(bridgeContext.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bridgeContext.cfg.snowluma?.accessToken ? { authorization: `Bearer ${bridgeContext.cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

export function clampGapV2(bridgeContext, ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

export function computeGapsV2(bridgeContext, messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(bridgeContext.clampGapV2(gaps[i], sendCfg));
      } else {
        const g = bridgeContext.clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(bridgeContext.clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(bridgeContext.clampGapV2(bridgeContext.randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

export function sendMessagesV2(bridgeContext, key, messages, delays, replyToMessageId, atUserId = null) {
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      bridgeContext.sendChain = bridgeContext.sendChain
        .then(async () => {
          await bridgeContext.onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          bridgeContext.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        bridgeContext.sendChain = bridgeContext.sendChain.then(() => bridgeContext.sleep(d));
      }
    }
    return bridgeContext.sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

export function shouldAuditKey(bridgeContext, key) {
    if (bridgeContext.currentMode === 'closed-agent') {
      return !(key === `private:${String(bridgeContext.cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

export function shouldBlockSilentReply(bridgeContext, key) {
    const roleState = bridgeContext.readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(bridgeContext.cfg.ownerQQ ?? '')}`;
  }

export async function auditAndSend(bridgeContext, key, text) {
    const hasKnownToken = [...bridgeContext.KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (bridgeContext.shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      bridgeContext.log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      bridgeContext.appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (bridgeContext.cfg.security?.interceptNotify !== false) {
        await bridgeContext.sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await bridgeContext.sendToQQ(key, text);
    return true;
  }
