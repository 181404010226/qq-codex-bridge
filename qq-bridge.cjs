'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { BridgeStore } = require('./bridge-store.cjs');
const { OneBotClient } = require('./onebot-client.cjs');
const { DesktopClient } = require('./desktop-client.cjs');
const { AttachmentManager, attachmentSegments, outgoingFiles } = require('./attachments.cjs');
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

function loadConfig(root = ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8'));
  if (!/^\d{5,12}$/.test(config.accountId || '')) throw Error('请配置接收消息的 QQ 号码');
  if (!/^[a-f0-9-]{36}$/i.test(config.threadId || '') || config.hostId !== 'local') throw Error('请绑定一个本机 Codex 聊天');
  if (!Array.isArray(config.allowedUserIds) || !config.allowedUserIds.length || config.allowedUserIds.some(id => !/^\d{5,12}$/.test(String(id)) || String(id) === String(config.accountId))) throw Error('请先配置控制联系人的 QQ 号码白名单');
  const url = new URL(config.onebotUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search) throw Error('QQ 接口必须是本机 127.0.0.1 的 WebSocket');
  if (typeof config.onebotToken !== 'string' || config.onebotToken.length < 24 || typeof config.controlToken !== 'string' || config.controlToken.length < 24) throw Error('本机接口令牌未配置');
  if (!Number.isInteger(config.statusPort) || config.statusPort < 1024 || config.statusPort > 65535) throw Error('状态端口无效');
  config.pollMs = Math.max(1500, Number(config.pollMs) || 3000);
  config.maxMessageChars = Math.min(50000, Math.max(1000, Number(config.maxMessageChars) || 16000));
  config.replyChunkChars = Math.min(3000, Math.max(500, Number(config.replyChunkChars) || 1500));
  config.queueLimit = Math.min(200, Math.max(1, Number(config.queueLimit) || 40));
  config.allowedUserIds = config.allowedUserIds.map(String);
  return config;
}

function textOf(event) {
  if (Array.isArray(event.message)) return event.message.filter(s => s.type === 'text' && typeof s.data?.text === 'string').map(s => s.data.text).join('').trim();
  // A string event might contain CQ markup. Never forward it as a command or render it back as CQ.
  return typeof event.message === 'string' ? event.message.replace(/\[CQ:[^\]]*\]/g, '').trim() : '';
}
function userText(item) {
  if (typeof item.text === 'string') return item.text;
  return (item.content || []).filter(c => c.type === 'text' || c.type === 'inputText').map(c => c.text || '').join('\n');
}
function matchingTurn(read, row) {
  return (read.turns || []).find(t => t.id === row.turn_id || (t.items || []).some(item => {
    if (item.type === 'userMessage') return userText(item).trimStart().startsWith(row.marker);
    // Desktop app-tools messages are persisted as functionCallOutput delegation,
    // not userMessage. Only this specific input envelope may establish correlation.
    if (item.type !== 'functionCallOutput' || !['send_message_to_thread', 'create_thread'].includes(item.name) || item.namespace !== 'codex_app') return false;
    const output = typeof item.output === 'string' ? item.output : item.output?.text;
    if (typeof output !== 'string' || !output.trimStart().startsWith('<codex_delegation>')) return false;
    const source = output.match(/<source_thread_id>([^<]+)<\/source_thread_id>/)?.[1]?.trim();
    const expectedSource = item.name === 'create_thread' && row.id === read.creationInboundId ? read.creationSourceThreadId : read.thread?.id;
    if (!expectedSource || source !== expectedSource) return false;
    if (item.name === 'create_thread' && !read.creationSourceThreadId) return false;
    const input = output.match(/<input>([\s\S]*)<\/input>/)?.[1];
    return input?.startsWith(row.marker) || false;
  }));
}
function finalText(turn) {
  const messages = (turn.items || []).filter(i => i.type === 'agentMessage' && typeof i.text === 'string');
  const final = messages.filter(i => ['final_answer', 'final'].includes(i.phase));
  if (final.length) return final.map(i => i.text).join('\n\n').trim();
  // Some desktop versions omit phase. Explicit commentary is never used as a final answer.
  return messages.filter(i => i.phase == null).at(-1)?.text.trim() || '';
}
function splitReply(text, limit) {
  const points = Array.from(text);
  if (points.length <= limit) return [text];
  const chunks = [];
  while (points.length) {
    let end = Math.min(limit, points.length);
    if (points.length > limit) {
      const breakAt = points.slice(0, end).lastIndexOf('\n');
      if (breakAt > limit / 2) end = breakAt + 1;
    }
    chunks.push(points.splice(0, end).join(''));
  }
  return chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）\n${chunk}`);
}

class QQBridge {
  constructor({ config, store, qq, desktop, attachments = null, log = () => {} }) {
    this.config = config; this.store = store; this.qq = qq; this.desktop = desktop; this.log = log;
    this.attachments = attachments;
    this.channel = config.channel || 'QQ';
    this.accountVerified = false; this.desktopConnected = false; this.lastError = null;
    this.busy = false; this.sending = false; this.delivering = false; this.timer = null; this.startedAt = Date.now(); this.stopped = false; this.lastDesktopProbe = 0;
    const since = this.store.getSetting('acceptSince');
    this.acceptSince = since == null ? Math.floor(Date.now() / 1000) - 60 : Number(since);
    if (since == null) this.store.setSetting('acceptSince', this.acceptSince);
    this.qq.on('connected', () => this.verifyAccount().catch(error => this.report(error)));
    this.qq.on('disconnected', () => { this.accountVerified = false; this.log('qq_disconnected'); });
    this.qq.on('event', event => this.receive(event).catch(error => this.report(error)));
  }
  scrub(error) {
    let text = String(error?.message || error);
    for (const token of [this.config.onebotToken, this.config.nativeToken, this.config.controlToken].filter(Boolean)) text = text.replaceAll(token, '[redacted]');
    return text.slice(0, 500);
  }
  report(error) { this.lastError = this.scrub(error); this.log('error', { message: this.lastError }); }
  paused() { return Boolean(this.config.isPaused?.()) || this.store.getSetting('paused', '0') === '1'; }
  async verifyAccount() {
    const login = await this.qq.call('get_login_info');
    if (String(login.user_id) !== String(this.config.accountId)) {
      this.accountVerified = false;
      throw Error(this.channel + '接口登录的账号与配置不符，桥接已拒绝接收');
    }
    this.accountVerified = true; this.lastError = null;
    this.log('qq_connected', { accountId: String(login.user_id), nickname: login.nickname });
    this.prepareAttachments();
    await Promise.all([this.flushOutbox(), this.deliverPending()]);
    this.tick().catch(error => this.report(error));
  }
  async receive(event) {
    if (event?.post_type === 'notice' && event.notice_type === 'offline_file' && event.file?.id) {
      event = { ...event, post_type: 'message', message_type: 'private', message_id: 'file:' + event.file.id,
        sender: { user_id: event.user_id }, message: [{ type: 'file', data: { ...event.file, file_id: event.file.id } }] };
    }
    if (event?.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' && String(event.self_id) === String(this.config.accountId)) {
      if (event.status?.online === false) { this.accountVerified = false; this.lastError = this.channel + '账号离线，等待重新连接'; }
      else if (event.status?.online === true && !this.accountVerified) await this.verifyAccount();
      return;
    }
    if (!this.accountVerified || !event || event.post_type !== 'message' || event.message_type !== 'private') return;
    if (String(event.self_id) !== String(this.config.accountId) || String(event.user_id) === String(this.config.accountId)) return;
    if (!this.config.allowedUserIds.includes(String(event.user_id))) return;
    if (event.sender?.user_id != null && String(event.sender.user_id) !== String(event.user_id)) return;
    if (event.message_id == null || !Number.isFinite(Number(event.time)) || Number(event.time) < this.acceptSince) return;
    const text = textOf(event);
    const emptySegments = Array.isArray(event.message) && event.message.every(segment =>
      segment?.type === 'text' && !String(segment.data?.text || '').trim());
    const emptyText = event.message == null || (typeof event.message === 'string' && !event.message.trim());
    const hasRawText = typeof event.raw_message === 'string' && Boolean(event.raw_message.trim());
    if ((emptySegments || emptyText) && !hasRawText) {
      this.log('empty_message_ignored', { messageId: String(event.message_id) });
      return;
    }
    this.store.transaction(() => this.routeMessage(event, text));
    this.prepareAttachments();
    await Promise.all([this.flushOutbox(), this.deliverPending()]);
    this.tick().catch(error => this.report(error));
  }
  routeMessage(event, text) {
    const files = this.attachments ? attachmentSegments(event) : [];
    const inputText = text || (files.length ? '请读取本条 QQ 附件，并结合当前任务处理。' : '');
    let row = this.store.accept(event, inputText.slice(0, this.config.maxMessageChars + 1), 'received');
    if (!row && files.length) {
      const existing = this.store.get(`${event.self_id}:${event.user_id}:${event.message_id}`);
      // Recover a media-only message acknowledged by the earlier text-only build.
      if (existing?.state === 'control' && !existing.text && !this.attachments.files(existing.id).length) {
        this.store.update(existing.id, { state: 'received', text: inputText }); row = this.store.get(existing.id);
      }
    }
    if (!row) return;
    this.log('qq_received', { messageId: row.message_id, userId: row.user_id });
    const respond = (message, kind = 'control') => {
      this.store.update(row.id, { state: 'control' }); this.store.enqueue(row.id, row.user_id, kind, [message]);
    };
    if (['/帮助', '/help', '/桥接帮助'].includes(text)) return respond(this.channel + ' ↔ Codex 桥接已连接。' + (this.attachments ? '文字与已下载的图片、文件' : '文字') + '会直接进入当前 Codex 聊天，任务进行中时作为即时引导，最终回答回到这里。\n/状态 查看连接和待连接消息\n/暂停 暂停接收，当前任务继续\n/恢复 恢复接收');
    if (['/状态', '/status', '/桥接状态'].includes(text)) {
      const warning = this.deliveryWarning();
      return respond(`${this.channel} ${this.accountVerified ? '已连接' : '未连接'}\nCodex ${this.desktopConnected ? '已连接' : '等待连接'}\n即时引导 ${this.paused() ? '已暂停' : '开启'}\n待连接消息 ${this.store.countQueued()}${this.attachments ? '\n准备附件消息 ' + this.attachments.waitingCount() : ''}\n处理中 ${this.store.active() ? '是' : '否'}\n聊天 ${this.config.threadId}${this.lastError ? '\n提示 ' + this.lastError : ''}${warning ? '\n' + warning : ''}`);
    }
    if (['/暂停', '/pause', '/桥接暂停'].includes(text)) { this.store.setSetting('paused', '1'); return respond('已暂停接收新任务。当前已开始的任务会继续，结果仍会回传。发 /恢复 可重新开启。'); }
    if (['/恢复', '/resume', '/桥接恢复'].includes(text)) { this.store.setSetting('paused', '0'); return respond('已恢复接收。直接发文字即可。'); }
    const captureActive = Number(this.store.getSetting('imageCaptureUntil', '0')) > Date.now() && Boolean(this.store.active());
    if (!files.length && !text && captureActive && Array.isArray(event.message) && event.message.some(segment => segment.type === 'image')) {
      return respond('实机截图已收到，我会遮挡隐私后补进当前视频。', 'image_received');
    }
    if (!text && !files.length) return respond(this.attachments ? '这条消息尚无可读取的文字或附件，请使用文字、图片或普通文件发送。' : '目前这个桥接接收文字消息。请用文字描述你要我处理的事。');
    if (text.length > this.config.maxMessageChars) return respond(`消息超过 ${this.config.maxMessageChars} 字，请拆成几条发送。`);
    if (this.paused()) return respond('桥接已暂停，这条消息未交给 Codex。发 /恢复 后再发送任务。');
    if (this.store.countQueued() + (this.attachments?.waitingCount() || 0) >= this.config.queueLimit) return respond('待处理消息较多，这条尚未交给 Codex，请稍后重发。');
    if (files.length) {
      if (files.length > 10) return respond('单条消息最多接收 10 个附件，请分开发送。');
      this.attachments.save(row, files);
      this.store.enqueue(row.id, row.user_id, 'attachment_ack', ['附件已收到，正在准备可读文件。准备完成后会直接送入 Codex。']);
      return;
    }
    this.store.update(row.id, { state: 'queued' });
    this.store.enqueue(row.id, row.user_id, 'ack', ['已收到，正在直接送入 Codex。正在执行的任务会收到这条补充指令。']);
  }
  prepareAttachments() {
    if (!this.stopped && this.accountVerified && this.attachments) this.attachments.poll().catch(error => this.report(error));
  }
  async deliverPending() {
    if (this.delivering || this.stopped || !this.accountVerified || this.paused()) return;
    this.delivering = true;
    try {
      for (let row; !this.stopped && this.accountVerified && !this.paused() && (row = this.store.next());) {
        this.store.update(row.id, { state: 'dispatching', dispatched_at: Date.now(), error: null });
        let prompt = this.config.promptForMessage ? this.config.promptForMessage(row) : `${row.marker}\n来源为已绑定的 ${this.channel} 控制联系人「${this.config.contactName}」，账号 ${row.user_id}。\n这是用户通过 ${this.channel} 发来的即时引导。任务执行中时，请把它合入当前轮次作为补充或纠正。空闲时正常开始处理。最终文字回答由桥接自动回传到这个 ${this.channel} 私聊。\n${this.config.toolInstructions || ''}\n${row.text}`;
        if (this.attachments) prompt += this.attachments.format(row.id);
        try {
          const result = await this.desktop.send(prompt);
          if (result.threadId !== this.config.threadId) throw Object.assign(Error('Codex 投递回执不完整'), { delivery: 'unknown' });
          this.store.update(row.id, { state: 'accepted' });
          this.desktopConnected = true;
          this.log('codex_accepted', { messageId: row.message_id, mode: 'steer' });
        } catch (error) {
          if (error.delivery === 'not_sent') {
            this.store.update(row.id, { state: 'queued', error: this.scrub(error) });
            this.store.enqueue(row.id, row.user_id, 'desktop_unavailable', ['消息已保存，正在等待 Codex 连接。接通后会直接送入当前轮次。']);
            this.desktopConnected = false;
            this.report(error);
            break;
          }
          if (error.delivery === 'rejected') {
            this.store.finish(row.id, 'failed', ['这条消息未能交给 Codex。' + this.scrub(error)], this.scrub(error));
          } else this.store.update(row.id, { error: this.scrub(error) });
          this.report(error);
        }
      }
    } finally { this.delivering = false; }
  }
  async flushOutbox() {
    if (this.sending || !this.accountVerified || this.stopped) return;
    this.sending = true;
    try {
      for (let row; !this.stopped && this.accountVerified && (row = this.store.nextOutbound());) {
        this.store.updateOutbound(row.id, 'sending');
        try {
          let result;
          if (['image', 'file'].includes(row.kind)) {
            const file = JSON.parse(row.text);
            result = row.kind === 'image' ? await this.qq.sendImage(row.user_id, file.path) : await this.qq.sendFile(row.user_id, file.path, file.name);
          } else result = await this.qq.send(row.user_id, row.text, { requestId: `bridge:${row.id}` });
          if (result?.message_id == null) throw Object.assign(Error(this.channel + '未返回消息编号，请核对是否已发送'), { delivery: 'unknown' });
          this.store.updateOutbound(row.id, 'sent', result.message_id);
          this.log('qq_sent', { kind: row.kind, messageId: String(result.message_id) });
        } catch (error) {
          this.store.updateOutbound(row.id, error.delivery === 'not_sent' ? 'ready' : error.delivery === 'rejected' ? 'failed' : 'uncertain', null, this.scrub(error));
          this.report(error); break;
        }
      }
    } finally { this.sending = false; }
  }
  async tick() {
    if (this.stopped) return;
    this.prepareAttachments();
    await this.deliverPending();
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.flushOutbox();
      // Probe Codex independently so QQ outages do not leave desktop health stale.
      const activeRows = this.store.activeRows();
      if (!activeRows.length && !this.store.countQueued() && Date.now() - this.lastDesktopProbe < 15000) return;
      this.lastDesktopProbe = Date.now();
      const read = await this.desktop.read({ light: !activeRows.length, turnIds: activeRows.map(row => row.turn_id).filter(Boolean) });
      if (read.thread?.id !== this.config.threadId) throw Error('Codex 聊天身份校验失败');
      this.desktopConnected = true; this.lastError = null;
      const finishedTurns = new Map();
      for (const active of activeRows) {
        const turn = matchingTurn(read, active);
        if (!turn) {
          if (active.state === 'dispatching' && Date.now() - active.dispatched_at > 120000) {
            this.store.finish(active.id, 'needs_review', ['这条消息的 Codex 接收结果尚未确认。为避免重复执行，我已停止自动重发；请在电脑上的原聊天核对。'], '未在近期轮次找到消息标记');
          }
          continue;
        }
        if (active.turn_id !== turn.id) this.store.update(active.id, { turn_id: turn.id, state: 'accepted' });
        if (turn.status === 'completed') {
          finishedTurns.set(turn.id, turn);
        } else if (['failed', 'interrupted', 'cancelled', 'error'].includes(turn.status)) {
          finishedTurns.set(turn.id, turn);
        }
      }
      for (const turn of finishedTurns.values()) {
        if (turn.status === 'completed') {
          const text = finalText(turn) || 'Codex 已完成这一轮，完整结果可查看电脑上的当前聊天。';
          let files = this.config.autoSendLocalFiles ? outgoingFiles(text, this.config.deliverablesRoot || path.join(this.config.root || ROOT, 'outputs')) : [];
          if (this.attachments) files = await this.attachments.stageOutgoing(files, turn.id);
          this.store.finishTurn(turn.id, 'completed', splitReply('【Codex】\n' + text, this.config.replyChunkChars), null, files);
          this.log('codex_completed', { turnId: turn.id });
        } else {
          const reason = this.scrub(turn.error?.message || `任务状态 ${turn.status}`);
          this.store.finishTurn(turn.id, 'failed', ['Codex 这一轮未正常完成。' + reason], reason);
        }
      }
      await this.flushOutbox();
    } catch (error) {
      this.desktopConnected = false; this.report(error);
      const pending = this.store.active() || this.store.next();
      if (pending && this.accountVerified) {
        this.store.enqueue(pending.id, pending.user_id, 'desktop_unavailable', ['消息已保存，但 Codex 桌面暂时无法连接。请在电脑上打开 Codex；连接恢复后会继续处理，不需要重复发送。']);
        await this.flushOutbox();
      }
    }
    finally { this.busy = false; }
  }
  deliveryWarning() {
    const count = this.store.outboundCounts().filter(row => ['uncertain', 'failed'].includes(row.state)).reduce((sum, row) => sum + row.count, 0);
    return count ? `有 ${count} 条 ${this.channel} 回传尚未确认，请在电脑核对对应聊天，避免重复发送。` : null;
  }
  snapshot() {
    const root = this.config.root || ROOT;
    const data = path.join(root, 'data');
    let guardian = null;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'guardian-process.json'), 'utf8'));
      if (saved.root === root) { process.kill(saved.pid, 0); guardian = saved.state; }
    } catch {}
    return { app: this.config.app || 'qq-codex-bridge', version: this.config.version || '1.1.0', deliveryMode: 'steer', root, pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(), accountId: String(this.config.accountId), contactName: this.config.contactName,
      threadId: this.config.threadId, qqConnected: this.accountVerified, desktopConnected: this.desktopConnected,
      paused: this.paused(), queued: this.store.countQueued(), processing: Boolean(this.store.active()),
      autoConnectEnabled: !fs.existsSync(path.join(data, 'autoconnect.disabled')), guardian,
      attachments: this.attachments?.snapshot() || [],
      attachmentLimitBytes: this.attachments?.maxBytes || null,
      outbox: this.store.outboundCounts(), recent: this.store.recent(), lastError: this.lastError, deliveryWarning: this.deliveryWarning() };
  }
  start() { this.qq.start(); this.timer = setInterval(() => this.tick(), this.config.pollMs); }
  stop() { this.stopped = true; clearInterval(this.timer); this.attachments?.stop(); this.qq.stop(); }
}

function secureEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function acquireLock(file) {
  let handle;
  try { handle = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('桥接锁文件损坏，请检查 data/service.lock'); }
    try { process.kill(old.pid, 0); throw Error('QQ 桥接已在运行'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(file); handle = fs.openSync(file, 'wx', 0o600);
  }
  const nonce = crypto.randomUUID();
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, nonce, root: ROOT })); fs.closeSync(handle);
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce) fs.unlinkSync(file); } catch {} };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const config = loadConfig();
  const unlock = acquireLock(path.join(DATA, 'service.lock'));
  const store = new BridgeStore(path.join(DATA, 'bridge.sqlite'));
  const log = (event, details = {}) => {
    // Store operational metadata only. Message contents remain in the local queue DB.
    const file = path.join(DATA, 'bridge.log');
    try { if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.previous'); } catch {}
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
  };
  config.root = ROOT; config.version = '1.2.1'; config.autoSendLocalFiles = true;
  const qq = new OneBotClient(config);
  const bridge = new QQBridge({ config, store, qq, desktop: new DesktopClient(config.threadId), log });
  bridge.attachments = new AttachmentManager({ root: ROOT, store, qq, onReady: () => {
    bridge.deliverPending().catch(error => bridge.report(error)); bridge.tick().catch(error => bridge.report(error));
  } });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true; bridge.stop();
    server.close();
    // Wait for any outstanding persistence operations; forced exit preserves uncertain sends.
    const deadline = Date.now() + 25000;
    const poll = setInterval(() => {
      if ((!bridge.busy && !bridge.sending && !bridge.delivering && !bridge.attachments?.busy) || Date.now() > deadline) {
        clearInterval(poll); store.close(); unlock(); process.exit(0);
      }
    }, 100);
  };
  const server = http.createServer((req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || ![`127.0.0.1:${config.statusPort}`].includes(req.headers.host)) return send(403, { error: '仅限本机访问' });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${config.statusPort}`) return send(403, { error: '请求来源不受信任' });
    if (req.method === 'GET' && ['/health', '/status'].includes(req.url)) return send(200, bridge.snapshot());
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(ROOT, 'status.html')));
    }
    if (req.method === 'POST' && req.url === '/recover-message') {
      if (!secureEqual(req.headers.authorization, 'Bearer ' + config.controlToken)) return send(403, { error: '需要本机控制令牌' });
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const messageId = JSON.parse(body).messageId;
          if (!/^-?\d{1,12}$/.test(String(messageId))) throw Error('QQ 消息编号无效');
          const message = await qq.call('get_msg', { message_id: Number(messageId) });
          await bridge.receive({ ...message, self_id: config.accountId, post_type: 'message' });
          send(200, { ok: true });
        } catch { send(400, { error: '消息恢复失败，请核对消息编号和本机 QQ 连接' }); }
      });
      return;
    }
    if (req.method === 'POST' && ['/pause', '/resume', '/stop'].includes(req.url)) {
      if (!secureEqual(req.headers.authorization, 'Bearer ' + config.controlToken)) return send(403, { error: '需要本机控制令牌' });
      if (req.url === '/stop') { send(200, { ok: true }); setImmediate(shutdown); return; }
      store.setSetting('paused', req.url === '/pause' ? '1' : '0'); return send(200, { ok: true, paused: bridge.paused() });
    }
    return send(404, { error: '未找到接口' });
  });
  server.on('error', error => { bridge.stop(); store.close(); unlock(); console.error(error.message); process.exit(1); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  await new Promise(resolve => server.listen(config.statusPort, '127.0.0.1', resolve));
  log('started', { threadId: config.threadId, accountId: config.accountId });
  bridge.start();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { QQBridge, loadConfig, textOf, matchingTurn, finalText, splitReply };
