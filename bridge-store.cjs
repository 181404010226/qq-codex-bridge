'use strict';
const { DatabaseSync } = require('node:sqlite');

class BridgeStore {
  constructor(file, channel = 'QQ', { database = null, peerId = null } = {}) {
    this.channel = channel;
    this.peerId = peerId;
    this.ownsDatabase = !database;
    this.db = database || new DatabaseSync(file);
    if (database) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_id TEXT NOT NULL,
        text TEXT NOT NULL, marker TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        received_at INTEGER NOT NULL, dispatched_at INTEGER, turn_id TEXT, error TEXT,
        UNIQUE(user_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, inbound_id TEXT NOT NULL,
        kind TEXT NOT NULL, part INTEGER NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready', qq_message_id TEXT, error TEXT,
        UNIQUE(inbound_id, kind, part)
      );
      CREATE INDEX IF NOT EXISTS inbound_queue ON inbound(state, received_at);
      CREATE INDEX IF NOT EXISTS outbox_queue ON outbox(state, id);`);
    this.db.prepare("UPDATE outbox SET state='uncertain',error=? WHERE state='sending'").run('服务上次退出时正在发送，请人工核对' + channel);
  }
  scope(peerId) { return new BridgeStore(null, this.channel, { database: this.db, peerId: String(peerId) }); }
  settingKey(key) { return this.peerId == null ? key : `peer:${this.peerId}:${key}`; }
  getSetting(key, fallback = null) { return this.db.prepare('SELECT value FROM setting WHERE key=?').get(this.settingKey(key))?.value ?? fallback; }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setSetting(key, value) { this.db.prepare('INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.settingKey(key), String(value)); }
  accept(event, text, state = 'queued') {
    const id = `${event.self_id}:${event.user_id}:${event.message_id}`;
    const marker = `[${this.channel}桥接消息 ${id}]`;
    const result = this.db.prepare('INSERT OR IGNORE INTO inbound(id,user_id,message_id,text,marker,state,received_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, String(event.user_id), String(event.message_id), text, marker, state, Date.now());
    return result.changes ? this.get(id) : null;
  }
  get(id) { return this.db.prepare('SELECT * FROM inbound WHERE id=?').get(id); }
  update(id, values) {
    const allowed = new Set(['state', 'dispatched_at', 'turn_id', 'error', 'text']);
    const entries = Object.entries(values).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE inbound SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([,value]) => value), id);
  }
  active() { return this.activeRows()[0]; }
  activeRows() { return this.db.prepare("SELECT * FROM inbound WHERE state IN ('dispatching','accepted') AND (? IS NULL OR user_id=?) ORDER BY received_at,rowid").all(this.peerId, this.peerId); }
  next() { return this.db.prepare("SELECT * FROM inbound WHERE state='queued' AND (? IS NULL OR user_id=?) ORDER BY received_at,rowid LIMIT 1").get(this.peerId, this.peerId); }
  countQueued() { return this.db.prepare("SELECT count(*) AS n FROM inbound WHERE state='queued' AND (? IS NULL OR user_id=?)").get(this.peerId, this.peerId).n; }
  enqueue(id, userId, kind, chunks) {
    const statement = this.db.prepare('INSERT OR IGNORE INTO outbox(inbound_id,kind,part,user_id,text) VALUES (?,?,?,?,?)');
    chunks.forEach((text, part) => statement.run(id, kind, part, String(userId), text));
  }
  finish(id, state, chunks, error = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.get(id);
      // An earlier delivery-status notice must not suppress a subsequently recovered answer.
      this.enqueue(id, row.user_id, state === 'completed' ? 'answer' : 'result', chunks);
      this.update(id, { state, error });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishTurn(turnId, state, chunks, error = null, files = []) {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM inbound WHERE turn_id=? AND state IN ('dispatching','accepted') AND (? IS NULL OR user_id=?)").all(turnId, this.peerId, this.peerId);
      for (const userId of new Set(rows.map(row => row.user_id))) {
        const replyId = `turn:${turnId}:${userId}`;
        this.enqueue(replyId, userId, state === 'completed' ? 'answer' : 'result', chunks);
        for (const kind of ['image', 'file']) this.enqueue(replyId, userId, kind, files.filter(file => file.kind === kind).map(file => JSON.stringify(file)));
      }
      this.db.prepare("UPDATE inbound SET state=?,error=? WHERE turn_id=? AND state IN ('dispatching','accepted') AND (? IS NULL OR user_id=?)").run(state, error, turnId, this.peerId, this.peerId);
    });
  }
  nextOutbound() { return this.db.prepare("SELECT * FROM outbox WHERE state='ready' AND (? IS NULL OR user_id=?) ORDER BY id LIMIT 1").get(this.peerId, this.peerId); }
  updateOutbound(id, state, qqMessageId = null, error = null) {
    this.db.prepare('UPDATE outbox SET state=?,qq_message_id=?,error=? WHERE id=?').run(state, qqMessageId == null ? null : String(qqMessageId), error, id);
  }
  outboundCounts() { return this.db.prepare('SELECT state,count(*) AS count FROM outbox WHERE (? IS NULL OR user_id=?) GROUP BY state').all(this.peerId, this.peerId); }
  recent() { return this.db.prepare('SELECT user_id,message_id,state,received_at,dispatched_at,turn_id,error FROM inbound WHERE (? IS NULL OR user_id=?) ORDER BY received_at DESC LIMIT 12').all(this.peerId, this.peerId); }
  close() { if (this.ownsDatabase) this.db.close(); }
}
module.exports = { BridgeStore };
