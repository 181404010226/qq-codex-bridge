'use strict';
// Adapted from the supplied CodexWorkbench 1.1.0 desktop-bridge.cjs.
// Reuses the running desktop. Never opens a second writer for its chat.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const ALLOWED = new Set(['read_thread', 'send_message_to_thread']);
const LIMIT = 32 * 1024 * 1024;

function readProjectedTurns(threadId, requestedTurnIds = [], roots = null) {
  const { DatabaseSync } = require('node:sqlite');
  const candidates = roots || [...new Set([process.env.CODEX_HOME, path.join(os.homedir(), '.codex')].filter(Boolean))];
  for (const root of candidates) {
    let database;
    try {
      const file = fs.readdirSync(root).filter(name => /^thread_history_\d+\.sqlite$/.test(name))
        .sort((left, right) => Number(right.match(/\d+/)[0]) - Number(left.match(/\d+/)[0]))[0];
      if (!file) continue;
      database = new DatabaseSync(path.join(root, file), { readOnly: true });
      const recent = database.prepare('SELECT * FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 10').all(threadId);
      if (!recent.length) continue;
      const turns = new Map(recent.map(turn => [turn.turn_id, turn]));
      const findTurn = database.prepare('SELECT * FROM thread_turns WHERE thread_id=? AND turn_id=?');
      for (const turnId of requestedTurnIds) {
        if (turns.has(turnId)) continue;
        const turn = findTurn.get(threadId, turnId);
        if (turn) turns.set(turnId, turn);
      }
      const findItems = database.prepare(`SELECT item_json FROM thread_items
        WHERE thread_id=? AND turn_id=? AND (
          item_type IN ('userMessage','agentMessage') OR
          (item_type='functionCallOutput' AND json_extract(item_json,'$.name') IN ('send_message_to_thread','create_thread')
            AND json_extract(item_json,'$.namespace')='codex_app')) ORDER BY rollout_ordinal`);
      return [...turns.values()].map(turn => ({
        id: turn.turn_id, status: turn.status, startedAt: turn.started_at, completedAt: turn.completed_at,
        error: turn.error_json ? JSON.parse(turn.error_json) : null,
        items: findItems.all(threadId, turn.turn_id).map(row => JSON.parse(row.item_json)),
      }));
    } catch {
      // A projection from another desktop version can be unavailable temporarily.
    } finally { database?.close(); }
  }
  return null;
}

function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  for (const item of result.contentItems || result.content || []) {
    if (typeof item.text !== 'string') continue;
    try { return JSON.parse(item.text); } catch {}
  }
  return null;
}

function request(pipe, method, params, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(pipe);
    let buffer = Buffer.alloc(0), done = false, transmitted = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) { error.delivery ||= transmitted ? 'unknown' : 'not_sent'; reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Codex 桌面响应超时')), timeout);
    socket.on('error', () => finish(Error('Codex 桌面连接中断')));
    socket.on('close', () => { if (!done) finish(Error('Codex 桌面连接已关闭')); });
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      transmitted = true;
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (!done && buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (length > LIMIT) return finish(Error('Codex 桌面返回数据过大'));
        if (buffer.length < length + 4) return;
        const packet = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        let message;
        try { message = JSON.parse(packet.toString('utf8')); }
        catch { return finish(Error('Codex 桌面返回格式错误')); }
        if (message.id !== id) continue;
        if (message.error) return finish(Object.assign(Error(message.error.message || 'Codex 拒绝请求'), { delivery: 'rejected' }));
        finish(null, message.result);
      }
    });
  });
}

class DesktopClient {
  constructor(threadId, { allowCreate = false } = {}) {
    this.threadId = threadId; this.cached = null; this.cachedAt = 0;
    this.allowed = new Set(ALLOWED);
    if (allowCreate) this.allowed.add('create_thread');
  }
  async inventory() {
    let names;
    try { names = fs.readdirSync('\\\\.\\pipe\\').filter(n => /^codex-app-tools-[a-f0-9-]+$/i.test(n)); }
    catch { return []; }
    const candidates = await Promise.all(names.map(async name => {
      const pipe = '\\\\.\\pipe\\' + name;
      try {
        const catalog = await request(pipe, 'tools/list', { threadStartKind: 'default' }, 2500);
        const tools = Object.fromEntries((catalog.tools || []).filter(t => this.allowed.has(t.name)).map(t => [t.name, t]));
        return tools.read_thread && tools.send_message_to_thread ? { pipe, tools } : null;
      } catch { return null; }
    }));
    return candidates.filter(Boolean);
  }
  async at(endpoint, name, args) {
    const tool = endpoint.tools[name];
    if (!tool) throw Object.assign(Error('当前 Codex 桌面不支持该操作'), { delivery: 'not_sent' });
    const callId = 'qq-bridge-' + crypto.randomUUID();
    const result = await request(endpoint.pipe, 'tools/call', {
      callerSource: 'codex', namespace: tool.namespace, tool: tool.name,
      arguments: args, threadId: this.threadId, callId, turnId: callId,
    }, ['send_message_to_thread', 'create_thread'].includes(name) ? 45000 : 12000);
    if (result?.success !== true || result?.isError) {
      const message = (result?.contentItems || result?.content || []).map(x => x.text).filter(Boolean).join('\n');
      throw Object.assign(Error(message || 'Codex 桌面未接受请求'), { delivery: 'rejected' });
    }
    const value = payload(result);
    if (!value) throw Object.assign(Error('Codex 桌面回执不完整'), { delivery: 'unknown' });
    return value;
  }
  async endpoint() {
    if (this.cached && Date.now() - this.cachedAt < 10000) return this.cached;
    const candidates = await this.inventory();
    if (!candidates.length) throw Object.assign(Error('请保持 Codex 桌面端打开'), { delivery: 'not_sent' });
    let endpoint;
    if (candidates.length === 1) endpoint = candidates[0];
    else {
      const probes = await Promise.allSettled(candidates.map(async e => ({ endpoint: e,
        read: await this.at(e, 'read_thread', { threadId: this.threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }),
      })));
      const loaded = probes.filter(p => p.status === 'fulfilled' && ['active', 'idle', 'systemError'].includes(p.value.read.thread?.status?.type));
      if (loaded.length !== 1) throw Object.assign(Error('多个 Codex 实例，无法唯一确认当前聊天归属'), { delivery: 'not_sent' });
      endpoint = loaded[0].value.endpoint;
    }
    this.cached = endpoint; this.cachedAt = Date.now();
    return endpoint;
  }
  async call(name, args) {
    if (!this.allowed.has(name) || (name !== 'create_thread' && args.threadId !== this.threadId)) throw Object.assign(Error('桥接仅可操作绑定的聊天'), { delivery: 'not_sent' });
    try { return await this.at(await this.endpoint(), name, args); }
    catch (error) { this.cached = null; throw error; }
  }
  async read(options = {}) {
    const result = await this.call('read_thread', { threadId: this.threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: options.light ? 100 : 1000 });
    if (!options.light) {
      const projected = readProjectedTurns(this.threadId, options.turnIds || []);
      if (projected) return { ...result, turns: projected };
    }
    // A projection can lag briefly during desktop upgrades. A larger native read
    // retains complete replies in that case. Ordinary polls stay compact.
    if (!options.light) return this.call('read_thread', {
      threadId: this.threadId, hostId: 'local', turnLimit: 10,
      includeOutputs: true, maxOutputCharsPerItem: 20000,
    }).then(read => {
      for (const turn of read.turns || []) for (const item of turn.items || []) {
        if (item.type === 'agentMessage' && ['final_answer', 'final'].includes(item.phase) && (item.truncated || item.text?.length >= 19990)) {
          item.text += '\n\n（回答较长，桌面接口可能截断了内容，完整回答请查看电脑上的原聊天。）';
        }
      }
      return read;
    });
    return result;
  }
  send(prompt) { return this.call('send_message_to_thread', { threadId: this.threadId, hostId: 'local', prompt }); }
  create(prompt, title, directoryName) { return this.call('create_thread', { prompt, title, target: { type: 'projectless', directoryName } }); }
}
module.exports = { DesktopClient, readProjectedTurns };
