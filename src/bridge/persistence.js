import fs from 'node:fs';

import path from 'node:path';
import crypto from 'node:crypto';

import { SENSITIVE_RE } from "../sensitive.js";

import { forwardIdFromData } from "../forward.js";

export function readJsonSafe(bridgeContext, file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

export function atomicWriteJson(bridgeContext, file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function atomicWriteText(bridgeContext, file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadOrCreateConsoleToken(bridgeContext) {
  const tokenFile = path.join(bridgeContext.STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  bridgeContext.atomicWriteText(tokenFile, token);
  return token;
}

export function readActivityTail(bridgeContext, n) {
  try {
    const raw = fs.readFileSync(bridgeContext.ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

export function listRoles(bridgeContext) {
  try {
    return fs.readdirSync(path.join(bridgeContext.ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

export function isCodexNoise(bridgeContext, text) {
  return bridgeContext.CODEX_NOISE_RE.test(String(text ?? ''));
}

export function isSilentMarker(bridgeContext, text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

export function isSendToolName(bridgeContext, name) {
  return bridgeContext.SEND_TOOL_RE.test(String(name ?? ''));
}

export function redactSensitiveText(bridgeContext, text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of bridgeContext.KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

export function escapeCqText(bridgeContext, text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

export function unquoteJsonString(bridgeContext, value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

export function appendActivity(bridgeContext, line) {
  try {
    fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(bridgeContext.ACTIVITY_LOG, `[${ts}] ${bridgeContext.redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
    // 只保留最近 500 行
    const raw = fs.readFileSync(bridgeContext.ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 500) fs.writeFileSync(bridgeContext.ACTIVITY_LOG, lines.slice(-500).join('\n'));
  } catch {}
}

export function readRoleState(bridgeContext) {
  return bridgeContext.readJsonSafe(bridgeContext.ROLE_STATE_FILE, { role: null, mode: 'active' });
}

export function writeRoleState(bridgeContext, role, mode) {
  bridgeContext.atomicWriteJson(bridgeContext.ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}

export function sanitizeRoleName(bridgeContext, name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

export function loadState(bridgeContext) {
  const loaded = bridgeContext.readJsonSafe(bridgeContext.STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') bridgeContext.state = loaded;
  else bridgeContext.state = { sessions: {} };
}

export function saveState(bridgeContext) {
  fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
  const tmp = bridgeContext.STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bridgeContext.state, null, 2));
  fs.renameSync(tmp, bridgeContext.STATE_FILE);
}

export function acquireLock(bridgeContext) {
  fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(bridgeContext.LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(bridgeContext.LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
          else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${bridgeContext.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${bridgeContext.LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(bridgeContext.LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${bridgeContext.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}

export function releaseLock(bridgeContext) {
  try {
    if (fs.existsSync(bridgeContext.LOCK_FILE) && Number(fs.readFileSync(bridgeContext.LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(bridgeContext.LOCK_FILE);
    }
  } catch {}
}

export function log(bridgeContext, ...args) {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => bridgeContext.redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
    fs.appendFileSync(bridgeContext.BRIDGE_LOG, line + '\n');
    const raw = fs.readFileSync(bridgeContext.BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) fs.writeFileSync(bridgeContext.BRIDGE_LOG, lines.slice(-2000).join('\n'));
  } catch {}
}

export function withTimeout(bridgeContext, promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function segmentsToText(bridgeContext, segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

export function extractMediaFromSegments(bridgeContext, segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

export function allowed(bridgeContext, kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

export function canonicalV2Key(bridgeContext, key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

export function readFeedbackEntries(bridgeContext) {
    const data = bridgeContext.readJsonSafe(bridgeContext.FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

export function appendFeedbackEntry(bridgeContext, entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: bridgeContext.redactSensitiveText(entry.message) } : {})
    };
    const list = bridgeContext.readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    bridgeContext.atomicWriteJson(bridgeContext.FEEDBACK_FILE, list);
  }

export function readToolLog(bridgeContext, limit = 200) {
    try {
      const raw = fs.readFileSync(bridgeContext.TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

export function appendToolLog(bridgeContext, entry) {
    try {
      fs.mkdirSync(bridgeContext.STATE_DIR, { recursive: true });
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = bridgeContext.redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(bridgeContext.redactSensitive(parsed));
        } else {
          safeEntry.args = bridgeContext.redactSensitiveText(safeEntry.args);
        }
      }
      fs.appendFileSync(bridgeContext.TOOL_LOG_FILE, JSON.stringify(safeEntry) + '\n', 'utf8');
      // 防止工具调用日志无限增长：保留最近 2000 行。
      const raw = fs.readFileSync(bridgeContext.TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n');
      if (lines.length > 2000) {
        fs.writeFileSync(bridgeContext.TOOL_LOG_FILE, lines.slice(-2000).join('\n') + '\n', 'utf8');
      }
    } catch (error) {
      bridgeContext.log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

export function redactSensitive(bridgeContext, obj) {
    if (Array.isArray(obj)) return obj.map(bridgeContext.redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = bridgeContext.SENSITIVE_ARG_KEYS.has(key) ? '***' : bridgeContext.redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return bridgeContext.redactSensitiveText(obj);
    return obj;
  }

export function sanitizeToolArgs(bridgeContext, args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = bridgeContext.redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
    return text;
  }
