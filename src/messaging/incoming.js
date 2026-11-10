import fs from 'node:fs';

import path from 'node:path';

import { mdToPlain } from "../md-to-plain.js";
import { SENSITIVE_RE } from "../sensitive.js";

import { extractForwardIds } from "../forward.js";

export async function handleIncoming(bridgeContext, kind, id, event, cfg) {
    const key = bridgeContext.convKey(kind, id);
    if (!bridgeContext.modeAllowed(key, kind, id, cfg, bridgeContext.currentMode)) {
      bridgeContext.log(`忽略未授权会话 ${key}（当前模式 ${bridgeContext.currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return bridgeContext.resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => bridgeContext.resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await bridgeContext.segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await bridgeContext.segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = bridgeContext.extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = bridgeContext.messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        bridgeContext.messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > bridgeContext.MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await bridgeContext.isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = bridgeContext.readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = bridgeContext.pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await bridgeContext.handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      bridgeContext.appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      bridgeContext.log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await bridgeContext.sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await bridgeContext.sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = bridgeContext.state.sessions[key];
        if (old) {
          bridgeContext.sessionEpoch++;
          delete bridgeContext.state.sessions[key];
          bridgeContext.reverse.delete(old);
          bridgeContext.collectors.delete(old);
          bridgeContext.sendToolSucceededSessions.delete(old);
          bridgeContext.pendingSendToolCalls.delete(old);
          bridgeContext.v2TurnStartAt.delete(old);
          bridgeContext.toolCallNames.delete(old);
          bridgeContext.social.silentTurns.delete(old);
          bridgeContext.social.exitingSessions.delete(old);
          const pe = bridgeContext.pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            bridgeContext.cancelPendingEntry(pe).catch(() => {});
          }
          bridgeContext.pending.delete(key);
          bridgeContext.queued.delete(key);
          bridgeContext.queuedHintAt.delete(key);
          bridgeContext.sessionPromises.delete(key);
          bridgeContext.drainPromptQueue(key, '会话已重置');
          bridgeContext.social.recentMessages.delete(key);
          bridgeContext.messageMediaStore.delete(key);
          bridgeContext.social.pendingSummaries.delete(key);
          bridgeContext.social.states.delete(key);
          bridgeContext.social.silentContext.delete(key);
          bridgeContext.slangWindows.delete(key);
          bridgeContext.slangExtractionCooldowns.delete(key);
          bridgeContext.slangSubmitTimes.delete(key);
          bridgeContext.cancelSocialTimers(key);
          bridgeContext.clearSocialV2Timers(key);
          bridgeContext.pendingWakeKeys.delete(key);
          bridgeContext.wakeConfigUpdatedKeys.delete(key);
          bridgeContext.markReadCalledKeys.delete(key);
          bridgeContext.wakeConfigMissCount.delete(key);
          const removedV2 = bridgeContext.socialV2.conversations.get(key);
          if (removedV2?.agentToken) bridgeContext.KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          bridgeContext.socialV2.conversations.delete(key);
          bridgeContext.seenForwardIds.delete(key);
          bridgeContext.saveSocialV2State();
          bridgeContext.saveState();
          await bridgeContext.sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = bridgeContext.readRoleState();
        await bridgeContext.sendToQQ(key, `会话 ${bridgeContext.state.sessions[key] ?? '未创建'}；白名单 ${bridgeContext.allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = bridgeContext.sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          bridgeContext.writeRoleState(null, roleState.mode);
          await bridgeContext.sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(bridgeContext.ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await bridgeContext.sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            bridgeContext.writeRoleState(name, roleState.mode);
            await bridgeContext.sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        bridgeContext.writeRoleState(roleState.role, 'silent');
        await bridgeContext.sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        bridgeContext.writeRoleState(roleState.role, 'active');
        await bridgeContext.sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (bridgeContext.currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      const atSelfSeg = Array.isArray(event.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id ?? ''));
      bridgeContext.appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), atSelfSeg);
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') bridgeContext.feedSlangWindow(key, sender, plainContent);
      if (bridgeContext.socialV2.paused) {
        bridgeContext.appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = bridgeContext.getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        bridgeContext.saveSocialV2State();
        bridgeContext.scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = bridgeContext.evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          bridgeContext.scheduleWakeV2(key, reason);
        } else if (kind === 'group') {
          // 【本地补丁】诊断：未命中任何唤醒条件时把判据打出来，避免"@ 没反应"无从排查。
          const dtr = st.wakeConfig?.triggers ?? {};
          bridgeContext.log(`[reserved2] 未命中唤醒 ${key}：atSelf=${atSelfSeg} quoteSelf=${quoteTargetIsSelf} atMention=${dtr.atMention} nameMention=${dtr.nameMention} question=${dtr.question} kw=${(dtr.keywords||[]).length} p=${dtr.probability} text=${String(plainContent||'').slice(0,30)}`);
        }
      }
      bridgeContext.appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      bridgeContext.feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 群聊带发送者信息；角色卡在实际投递时按 DSH 会话注入。
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + bridgeContext.mediaHintFor(key, messageRef, mediaList);

    bridgeContext.appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (bridgeContext.isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      bridgeContext.appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = bridgeContext.socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        bridgeContext.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        bridgeContext.log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && bridgeContext.triggerActiveDurationExit(key, st, Date.now())) {
        bridgeContext.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        bridgeContext.log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${isOwner ? '【管理员】' : ''}${textContent}${bridgeContext.mediaHintFor(key, messageRef, mediaList)}`;
          bridgeContext.scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          bridgeContext.log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        bridgeContext.log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = bridgeContext.isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        bridgeContext.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        bridgeContext.log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      bridgeContext.enterActive(key);
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? bridgeContext.DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${bridgeContext.SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${bridgeContext.SILENT_MARKER}；否则正常回复。\n${directionHint}${bridgeContext.SPACE_SPLIT_HINT}`;
      const promptText = `【群聊上下文】\n${bridgeContext.buildContextBlock(key)}\n【当前消息】${currentLine}${bridgeContext.mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        bridgeContext.log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await bridgeContext.deliverPrompt(key, promptText, { media: mediaList });
      } else {
        bridgeContext.scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!bridgeContext.dshReady) {
      const items = bridgeContext.queued.get(key) ?? [];
      if (items.length >= bridgeContext.QUEUE_MAX) {
        items.shift();
        bridgeContext.log(`队列满（${bridgeContext.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      bridgeContext.queued.set(key, items);
      const now = Date.now();
      if ((bridgeContext.queuedHintAt.get(key) ?? 0) + bridgeContext.QUEUE_HINT_COOLDOWN_MS < now) {
        bridgeContext.queuedHintAt.set(key, now);
        await bridgeContext.sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      bridgeContext.log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await bridgeContext.ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        bridgeContext.enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: bridgeContext.withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await bridgeContext.resolveMediaList(mediaList);
      content = [{ type: 'text', text: bridgeContext.withSlangContext(promptText) }, ...imageParts];
    }
    const accepted = await bridgeContext.api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = bridgeContext.shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (bridgeContext.isCodexNoise(errText)) bridgeContext.log(`[codex] 投递被拒，已对 QQ 静默：${errText.slice(0, 200)}`);
      else await bridgeContext.sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await bridgeContext.auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && bridgeContext.currentMode !== 'reserved2') await bridgeContext.sendToQQ(key, cfg.ackMessage);
    bridgeContext.log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }
