'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const WebSocket = require('ws');

class OneBotClient extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.socket = null; this.pending = new Map();
    this.connected = false; this.stopped = true; this.retry = 1000; this.timer = null; this.pingTimer = null;
  }
  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.onebotUrl, {
      headers: { Authorization: 'Bearer ' + this.config.onebotToken },
      handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024,
    });
    this.socket = socket;
    let alive = true;
    socket.on('open', () => {
      this.connected = true; this.retry = 1000;
      this.pingTimer = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false; socket.ping();
      }, 20000);
      this.emit('connected');
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.echo && this.pending.has(String(message.echo))) {
        const pending = this.pending.get(String(message.echo));
        this.pending.delete(String(message.echo)); clearTimeout(pending.timer);
        if (message.status === 'ok' && Number(message.retcode) === 0) pending.resolve(message.data);
        else pending.reject(Object.assign(Error(message.message || message.wording || `QQ 接口失败 (${message.retcode})`), { delivery: 'rejected' }));
      } else this.emit('event', message);
    });
    socket.on('error', () => { /* close schedules reconnect; never log the token-bearing connection */ });
    socket.on('close', () => {
      clearInterval(this.pingTimer); this.pingTimer = null;
      this.connected = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(Error('QQ 连接中断，接口结果待核对'), { delivery: 'unknown' }));
      }
      this.pending.clear(); this.emit('disconnected');
      if (!this.stopped) { this.timer = setTimeout(() => this.connect(), this.retry); this.retry = Math.min(30000, this.retry * 2); }
    });
  }
  call(action, params = {}, timeout = 20000) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(Error('QQ 尚未连接'), { delivery: 'not_sent' }));
    return new Promise((resolve, reject) => {
      const echo = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(Object.assign(Error('QQ 接口响应超时，结果待核对'), { delivery: 'unknown' }));
      }, timeout);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }), error => {
        if (!error || !this.pending.has(echo)) return;
        clearTimeout(timer); this.pending.delete(echo);
        reject(Object.assign(Error('QQ 接口发送未确认'), { delivery: 'unknown' }));
      });
    });
  }
  send(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text } }] });
  }
  sendImage(userId, file) {
    return this.call('send_private_msg', { user_id: Number(userId), message: [{ type: 'image', data: { file: pathToFileURL(path.resolve(file)).href } }] }, 60000);
  }
  sendFile(userId, file, name = path.basename(file)) {
    return this.call('send_private_msg', { user_id: Number(userId), message: [{ type: 'file', data: { file: pathToFileURL(path.resolve(file)).href, name } }] }, 60000);
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.pingTimer);
    this.socket?.close();
  }
}
module.exports = { OneBotClient };
