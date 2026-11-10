import { validateFetchUrl } from "../safe-fetch.js";

import { saveStickerStore, mergeStickerLibrary, findSticker, formatStickerList, applyStickerNote, markStickerUsed } from "../sticker-lib.js";

export function stickerEnabled(bridgeContext) {
    return bridgeContext.cfg.socialV2?.sticker?.enabled !== false;
  }

export function saveStickerStoreSafe(bridgeContext) {
    try { saveStickerStore(bridgeContext.STICKER_FILE, bridgeContext.stickerEntries); } catch (error) { bridgeContext.log('保存表情库失败:', error?.message ?? error); }
  }

export async function syncStickerLibrary(bridgeContext, force = false) {
    if (bridgeContext.cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(bridgeContext.cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && bridgeContext.stickerSyncedAt && now - bridgeContext.stickerSyncedAt < ttl) {
      return { entries: bridgeContext.stickerEntries, syncedAt: bridgeContext.stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(bridgeContext.cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bridgeContext.bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      bridgeContext.stickerEntries = mergeStickerLibrary(bridgeContext.stickerEntries, fetched);
      bridgeContext.stickerSyncedAt = Date.now();
      bridgeContext.saveStickerStoreSafe();
      bridgeContext.log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${bridgeContext.stickerEntries.length} 条）`);
      return { entries: bridgeContext.stickerEntries, syncedAt: bridgeContext.stickerSyncedAt, fromCache: false };
    } catch (error) {
      bridgeContext.log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

export async function listStickersForV2(bridgeContext, query = '', count = 48, force = false) {
    const synced = await bridgeContext.syncStickerLibrary(force);
    const entries = synced?.entries ?? bridgeContext.stickerEntries;
    return formatStickerList(entries, query, count);
  }

export async function getStickerImageData(bridgeContext, stickerId) {
    const synced = await bridgeContext.syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? bridgeContext.stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await bridgeContext.syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? bridgeContext.stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

export async function sendStickerV2(bridgeContext, key, stickerRef, options = {}) {
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await bridgeContext.syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? bridgeContext.stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 发送前校验表情 URL 必须是公网 http(s)，防止本地库被污染后诱导 OneBot 抓取内网/本机地址。
    try {
      await validateFetchUrl(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: url } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(bridgeContext.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    bridgeContext.sendChain = bridgeContext.sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await bridgeContext.sleep(bridgeContext.randInt(800, 2000));
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
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(bridgeContext.stickerEntries, entry.id, 'sticker');
    bridgeContext.stickerEntries = updated.entries;
    bridgeContext.saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

export function applyStickerNoteV2(bridgeContext, stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(bridgeContext.stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    bridgeContext.stickerEntries = updated.entries;
    bridgeContext.saveStickerStoreSafe();
    return updated.entry;
  }

export async function setStickerRemarkV2(bridgeContext, stickerId, remark) {
    const synced = await bridgeContext.syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? bridgeContext.stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bridgeContext.bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(bridgeContext.stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    bridgeContext.stickerEntries = updated.entries;
    bridgeContext.saveStickerStoreSafe();
    return bridgeContext.stickerEntries.find((e) => e.id === entry.id) || null;
  }

export async function collectStickerV2(bridgeContext, key, messageRef, remark) {
    const st = bridgeContext.getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await bridgeContext.fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await bridgeContext.fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    const addRes = await bridgeContext.bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(bridgeContext.cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      const modRes = await bridgeContext.bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        bridgeContext.log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await bridgeContext.syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? bridgeContext.stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }
