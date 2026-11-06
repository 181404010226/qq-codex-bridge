'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { BridgeStore } = require('../bridge-store.cjs');
const { QQBridge, textOf, finalText, splitReply, matchingTurn } = require('../qq-bridge.cjs');
const { DesktopClient, readProjectedTurns } = require('../desktop-client.cjs');
const { OneBotClient } = require('../onebot-client.cjs');
const { WebSocketServer } = require('ws');

const config = { accountId: '100000001', allowedUserIds: ['100000002'], contactName: '控制联系人',
  threadId: '11111111-1111-4111-8111-111111111111', hostId: 'local',
  onebotToken: 'a'.repeat(64), controlToken: 'b'.repeat(64), pollMs: 3000, maxMessageChars: 16000, replyChunkChars: 1500, queueLimit: 40 };
const event = (id, text, changes = {}) => ({ post_type: 'message', message_type: 'private',
  self_id: 100000001, user_id: 100000002, sender: { user_id: 100000002 },
  message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...changes });
const settled = () => new Promise(resolve => setImmediate(resolve));

class FakeQQ extends EventEmitter {
  constructor() { super(); this.sent = []; this.connected = true; this.error = null; }
  async call(action) { if (action === 'get_login_info') return { user_id: 100000001 }; throw Error('Unexpected action'); }
  async send(userId, text) {
    if (this.error) throw this.error;
    this.sent.push({ userId, text }); return { message_id: this.sent.length };
  }
  start() {} stop() {}
}
function fixture(t) {
  const parent = process.env.BRIDGE_TEST_TMP || os.tmpdir(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'qq-bridge-'));
  const file = path.join(root, 'queue.sqlite'); const store = new BridgeStore(file); const qq = new FakeQQ();
  const desktop = { sent: [], attempts: [], response: { thread: { id: config.threadId, status: { type: 'active' } }, turns: [] }, error: null,
    async read() { return this.response; }, async send(text) { this.attempts.push(text); if (this.error) throw this.error; this.sent.push(text); return { threadId: config.threadId }; } };
  const bridge = new QQBridge({ config, store, qq, desktop }); bridge.accountVerified = true;
  t.after(async () => { bridge.stop(); await settled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, store, qq, desktop, bridge };
}

test('only the bound private sender on the correct receiving account is accepted', async t => {
  const { bridge, store, qq, desktop } = fixture(t);
  for (const [i, changes] of [{ user_id: 12345 }, { message_type: 'group' }, { self_id: 12345 },
    { post_type: 'message_sent' }, { sender: { user_id: 12345 } }, { time: 1 }, { message_id: null }].entries()) {
    await bridge.receive(event(i, 'secret action', changes));
  }
  assert.equal(store.recent().length, 0); assert.equal(qq.sent.length, 0);
});

test('duplicate QQ events create exactly one durable task and one receipt', async t => {
  const { bridge, store, qq, desktop } = fixture(t);
  await bridge.receive(event(-42, '请处理这条')); await bridge.receive(event(-42, '请处理这条')); await settled();
  assert.equal(store.countQueued(), 0); assert.equal(qq.sent.length, 1); assert.equal(desktop.sent.length, 1);
  assert.equal(store.get('100000001:100000002:-42').text, '请处理这条');
});

test('empty QQ events are ignored before persistence and never produce a reply', async t => {
  const { bridge, store, qq, desktop } = fixture(t);
  for (const [index, message] of [[], '', undefined, [{ type: 'text', data: { text: '   ' } }]].entries()) {
    await bridge.receive(event(900 + index, '', { message, raw_message: '' }));
  }
  assert.equal(store.recent().length, 0);
  assert.equal(store.nextOutbound(), undefined);
  assert.equal(qq.sent.length, 0);
  assert.equal(desktop.sent.length, 0);
});

test('an empty placeholder does not suppress a later populated message with the same id', async t => {
  const { bridge, store, qq, desktop } = fixture(t);
  await bridge.receive(event(910, '', { message: [], raw_message: '' }));
  await bridge.receive(event(910, '后续补齐的正文'));
  await settled();
  assert.equal(store.recent().length, 1);
  assert.equal(qq.sent.length, 1);
  assert.equal(desktop.sent.length, 1);
  assert.match(desktop.sent[0], /后续补齐的正文/);
});

test('busy desktop receives successive messages immediately as guidance', async t => {
  const { bridge, store, desktop } = fixture(t);
  await bridge.receive(event(1, '第一条')); await bridge.receive(event(2, '第二条')); await settled();
  assert.equal(desktop.sent.length, 2); assert.equal(store.countQueued(), 0);
  assert.ok(desktop.sent[0].endsWith('第一条')); assert.ok(desktop.sent[1].endsWith('第二条'));
  assert.ok(desktop.sent[1].includes('即时引导')); assert.equal(store.activeRows().length, 2);
  await bridge.tick(); assert.equal(desktop.sent.length, 2);
});

test('guidance is delivered even while an earlier reply poll is blocked', async t => {
  const { bridge, desktop } = fixture(t);
  let finishRead;
  desktop.read = () => new Promise(resolve => { finishRead = resolve; });
  const poll = bridge.tick(); await settled();
  await bridge.receive(event(3, '立即纠正当前工作'));
  assert.equal(desktop.sent.length, 1);
  assert.ok(desktop.sent[0].endsWith('立即纠正当前工作'));
  finishRead(desktop.response); await poll;
});

test('multiple guidance messages sharing a turn return one final answer', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(10, '原始任务')); await bridge.receive(event(11, '补充要求')); await settled();
  const rows = store.activeRows();
  desktop.response.turns = [{ id: 'shared-turn', status: 'completed', items: [
    ...rows.map(row => ({ type: 'userMessage', text: row.marker })),
    { type: 'agentMessage', phase: 'final_answer', text: '全部要求已完成' },
  ] }];
  await bridge.tick(); await bridge.tick();
  assert.equal(store.activeRows().length, 0);
  assert.equal(qq.sent.filter(message => message.text === '【Codex】\n全部要求已完成').length, 1);
  assert.ok(rows.every(row => store.get(row.id).state === 'completed'));
});

test('read-only projection keeps complete replies and scoped delegation inputs', t => {
  const { root } = fixture(t);
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
  database.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,error_json TEXT,rollout_ordinal INTEGER);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER);`);
  const turn = database.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)');
  for (let index = 0; index < 12; index++) turn.run(config.threadId, 'turn-' + index, 'completed', 1, 2, null, index);
  turn.run('other-thread', 'other-turn', 'completed', 1, 2, null, 100);
  const fullText = '完整回答😀'.repeat(10000);
  const items = [
    { type: 'agentMessage', phase: 'final_answer', text: fullText },
    { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: '<codex_delegation>input</codex_delegation>' } },
    { type: 'functionCallOutput', namespace: 'shell', name: 'exec_command', output: 'secret tool output' },
    { type: 'reasoning', text: 'private reasoning' },
  ];
  const item = database.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?)');
  items.forEach((value, index) => item.run(config.threadId, 'turn-0', value.type, JSON.stringify(value), index));
  database.close();
  const turns = readProjectedTurns(config.threadId, ['turn-0'], [root]);
  assert.equal(turns.length, 11);
  const older = turns.find(value => value.id === 'turn-0');
  assert.equal(older.items.length, 2); assert.equal(older.items[0].text, fullText);
  assert.equal(older.items[1].name, 'send_message_to_thread');
  assert.equal(readProjectedTurns('missing-thread', [], [root]), null);
});

test('only the correlated final answer is returned; unrelated answers and reasoning never leave', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(7, '算一下')); await settled();
  desktop.response.thread.status.type = 'idle'; await bridge.tick();
  const row = store.active();
  desktop.response.turns = [{ id: 'unrelated', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'OTHER CHAT CONTENT' }] },
    { id: 'correlated', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: row.marker + '\n算一下' }] },
      { type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'commandExecution', output: 'SECRET TOOL OUTPUT' },
      { type: 'agentMessage', phase: 'commentary', text: 'PUBLIC PROGRESS' },
      { type: 'agentMessage', phase: 'final_answer', text: '结果是 42。' },
    ] }];
  await bridge.tick(); await bridge.tick();
  assert.equal(store.get(row.id).state, 'completed'); assert.equal(qq.sent.length, 2);
  assert.equal(qq.sent[1].text, '【Codex】\n结果是 42。');
});

test('real desktop functionCallOutput delegation is correlated and automatically returned to QQ', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(2046632368, '我收到了，请回复“你好，世界”')); await settled();
  desktop.response.thread.status.type = 'idle'; await bridge.tick(); const row = store.active();
  desktop.response.turns = [{ id: 'real-desktop-delegated-turn', status: 'completed', items: [
    { type: 'functionCallOutput', id: 'fco-id', name: 'send_message_to_thread', namespace: 'codex_app', output: {
      text: `<codex_delegation>\n  <source_thread_id>${config.threadId}</source_thread_id>\n  <input>${row.marker}\n来源：已绑定的QQ联系人。\n\n${row.text}</input>\n</codex_delegation>`, truncated: false,
    } },
    { type: 'reasoning', summary: [], content: ['NEVER TRANSMIT'] },
    { type: 'agentMessage', id: 'final-id', phase: 'final_answer', text: '你好，世界' },
  ] }];
  await bridge.tick();
  assert.equal(store.get(row.id).turn_id, 'real-desktop-delegated-turn');
  assert.equal(store.get(row.id).state, 'completed');
  assert.equal(qq.sent.at(-1).text, '【Codex】\n你好，世界');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='answer' AND state='sent'").get().n, 1);
});

test('a marker quoted in another tool, another source thread, or commentary cannot claim a reply', () => {
  const row = { marker: '[QQ桥接消息 1:2:3]', turn_id: null };
  const output = `<codex_delegation><source_thread_id>${config.threadId}</source_thread_id><input>${row.marker}\nhello</input></codex_delegation>`;
  const envelope = { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: output } };
  const find = item => matchingTurn({ thread: { id: config.threadId }, turns: [{ id: 't', items: [item] }] }, row);
  assert.equal(find({ ...envelope, name: 'exec_command' }), undefined);
  assert.equal(find({ ...envelope, namespace: 'untrusted' }), undefined);
  assert.equal(find({ ...envelope, output: { text: output.replace(config.threadId, 'other-thread') } }), undefined);
  assert.equal(find({ type: 'agentMessage', text: row.marker, phase: 'commentary' }), undefined);
  assert.equal(find({ type: 'userMessage', text: 'quotation: ' + row.marker }), undefined);
  assert.equal(find(envelope).id, 't');
});

test('desktop polling uses compact native reads before hydrating replies locally', async () => {
  const client = new DesktopClient(config.threadId); const calls = [];
  client.call = async (name, args) => { calls.push(args); return { thread: { id: config.threadId }, turns: [] }; };
  await client.read({ light: true });
  assert.equal(calls[0].includeOutputs, false); assert.equal(calls[0].turnLimit, 1);
});

test('a previously sent timeout notice does not suppress a recovered final answer', t => {
  const { store } = fixture(t); const row = store.accept(event(123, 'recover'), 'recover');
  store.finish(row.id, 'needs_review', ['timeout']); const notice = store.nextOutbound(); store.updateOutbound(notice.id, 'sent', 9);
  store.finish(row.id, 'completed', ['你好，世界']); const answer = store.nextOutbound();
  assert.equal(answer.kind, 'answer'); assert.equal(answer.text, '你好，世界'); assert.notEqual(answer.id, notice.id);
});

test('pause, status and resume stay local; paused tasks are not dispatched', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(1, '/暂停')); await bridge.receive(event(2, '不要执行')); await bridge.receive(event(3, '/状态'));
  assert.equal(bridge.paused(), true); assert.equal(store.countQueued(), 0);
  assert.ok(qq.sent.some(x => x.text.includes('这条消息未交给 Codex')));
  await bridge.receive(event(4, '/恢复')); assert.equal(bridge.paused(), false);
  assert.equal(desktop.sent.length, 0);
});

test('an already accepted task still returns its result while receiving is paused', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(1, '运行')); await settled(); desktop.response.thread.status.type = 'idle'; await bridge.tick();
  const row = store.active(); store.setSetting('paused', '1');
  desktop.response.turns = [{ id: 't', status: 'completed', items: [{ type: 'userMessage', text: row.marker }, { type: 'agentMessage', phase: 'final_answer', text: '完成' }] }];
  await bridge.tick(); assert.ok(qq.sent.some(x => x.text.includes('完成')));
});

test('unknown Codex delivery is reconciled by marker and is never blindly retried', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  desktop.error = Object.assign(Error('timeout'), { delivery: 'unknown' });
  await bridge.receive(event(1, '只执行一次')); await settled(); desktop.response.thread.status.type = 'idle';
  await bridge.tick();
  const row = store.active(); assert.equal(row.state, 'dispatching');
  await bridge.tick(); assert.equal(desktop.attempts.length, 1);
  store.update(row.id, { dispatched_at: Date.now() - 121000 }); await bridge.tick();
  assert.equal(store.get(row.id).state, 'needs_review'); assert.equal(desktop.attempts.length, 1);
  await bridge.flushOutbox(); assert.ok(qq.sent.some(x => x.text.includes('停止自动重发')));
});

test('unknown Codex delivery can recover a completed marked turn', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  desktop.error = Object.assign(Error('timeout'), { delivery: 'unknown' });
  await bridge.receive(event(1, '恢复')); await settled(); desktop.response.thread.status.type = 'idle';
  await bridge.tick(); const row = store.active();
  desktop.response.turns = [{ id: 'r', status: 'completed', items: [{ type: 'userMessage', text: row.marker }, { type: 'agentMessage', phase: 'final_answer', text: '已恢复' }] }];
  await bridge.tick(); assert.equal(desktop.attempts.length, 1); assert.equal(store.get(row.id).state, 'completed');
  assert.ok(qq.sent.some(x => x.text.includes('已恢复')));
});

test('explicitly accepted guidance tolerates a delayed desktop projection', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  await bridge.receive(event(88, '等待当前执行边界')); await settled();
  const row = store.active();
  store.update(row.id, { dispatched_at: Date.now() - 180000 });
  await bridge.tick();
  assert.equal(store.get(row.id).state, 'accepted');
  assert.equal(desktop.sent.length, 1);
  assert.ok(!qq.sent.some(message => message.text.includes('接收结果尚未确认')));
});

test('offline QQ prevents new model work; unknown QQ send is not resent', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  bridge.accountVerified = false; await bridge.tick(); assert.equal(desktop.sent.length, 0);
  bridge.accountVerified = true; qq.error = Object.assign(Error('lost reply'), { delivery: 'unknown' });
  await bridge.receive(event(1, '/帮助')); await settled();
  assert.deepEqual(store.outboundCounts().map(x => [x.state, x.count]), [['uncertain', 1]]);
  assert.match(bridge.deliveryWarning(), /1 条 QQ 回传/);
  qq.error = null; await bridge.flushOutbox(); assert.equal(qq.sent.length, 0);
});

test('QQ offline heartbeat suspends dispatch and an online heartbeat revalidates the account', async t => {
  const { bridge } = fixture(t);
  await bridge.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 100000001, status: { online: false } });
  assert.equal(bridge.accountVerified, false);
  await bridge.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 100000001, status: { online: true } });
  assert.equal(bridge.accountVerified, true);
});

test('Codex outage preserves queued work and notifies QQ only once for that message', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  desktop.error = Object.assign(Error('desktop offline'), { delivery: 'not_sent' });
  desktop.read = async () => { throw Error('desktop offline'); };
  await bridge.receive(event(1, '等恢复后执行')); await settled(); await bridge.tick(); await bridge.tick();
  assert.equal(store.countQueued(), 1); assert.equal(desktop.sent.length, 0);
  assert.equal(qq.sent.filter(row => row.text.includes('正在等待 Codex 连接')).length, 1);
});

test('SQLite recovery preserves queued work and marks an in-flight reply uncertain', t => {
  const { root } = fixture(t); const file = path.join(root, 'recovery.sqlite');
  let store = new BridgeStore(file); const row = store.accept(event(123, 'persist'), 'persist');
  store.enqueue(row.id, row.user_id, 'result', ['result']); const out = store.nextOutbound(); store.updateOutbound(out.id, 'sending'); store.close();
  store = new BridgeStore(file); assert.equal(store.countQueued(), 1); assert.equal(store.get(row.id).text, 'persist');
  assert.equal(store.nextOutbound(), undefined); assert.equal(store.outboundCounts()[0].state, 'uncertain'); store.close();
});

test('inbound task and receipt changes roll back together on storage error', t => {
  const { store } = fixture(t);
  assert.throws(() => store.transaction(() => { const row = store.accept(event(1, 'atomic'), 'atomic'); store.enqueue(row.id, row.user_id, 'ack', ['ack']); throw Error('disk full'); }));
  assert.equal(store.countQueued(), 0); assert.equal(store.nextOutbound(), undefined);
});

test('queue capacity and oversized/media-only input do not start model work', async t => {
  const { bridge, store, desktop, qq } = fixture(t); bridge.config = { ...config, queueLimit: 1 };
  desktop.error = Object.assign(Error('desktop offline'), { delivery: 'not_sent' });
  await bridge.receive(event(1, 'first')); await bridge.receive(event(2, 'second'));
  await bridge.receive(event(3, 'x'.repeat(16001))); await bridge.receive(event(4, '', { message: [{ type: 'image', data: { file: 'untrusted' } }] }));
  assert.equal(store.countQueued(), 1); assert.equal(desktop.sent.length, 0);
  assert.ok(qq.sent.some(x => x.text.includes('待处理消息较多'))); assert.ok(qq.sent.some(x => x.text.includes('超过'))); assert.ok(qq.sent.some(x => x.text.includes('文字消息')));
});

test('explicit active screenshot capture acknowledges an image locally without starting another task', async t => {
  const { bridge, store, desktop, qq } = fixture(t);
  const row=store.accept(event(100, 'edit current video'), 'edit current video');
  store.update(row.id,{state:'accepted',dispatched_at:Date.now()});
  store.setSetting('imageCaptureUntil',Date.now()+60000);
  await bridge.receive(event(101,'',{message:[{type:'image',data:{file:'screenshot.png'}}]}));
  await settled();
  assert.equal(store.get('100000001:100000002:101').state,'control');
  assert.ok(qq.sent.some(m=>m.text.includes('实机截图已收到')));
  assert.equal(desktop.sent.length,0);
});

test('reply chunks retain all Unicode and explicit commentary is never a final answer', () => {
  const source = ('你好😀\n').repeat(1000); const parts = splitReply(source, 1000);
  assert.equal(parts.map(p => p.replace(/^（\d+\/\d+）\n/, '')).join(''), source);
  assert.ok(parts.every(p => !/[\uD800-\uDBFF]$/.test(p)));
  assert.equal(finalText({ items: [{ type: 'reasoning', text: 'no' }, { type: 'agentMessage', phase: 'commentary', text: 'not final' }] }), '');
  assert.equal(textOf({ message: 'hello[CQ:image,file=x]' }), 'hello');
});

test('desktop client refuses requests targeting any other chat', async () => {
  const client = new DesktopClient(config.threadId);
  await assert.rejects(client.call('send_message_to_thread', { threadId: 'another-chat', prompt: 'bad' }), /绑定的聊天/);
  await assert.rejects(client.call('create_thread', { threadId: config.threadId }), /绑定的聊天/);
});

test('OneBot uses authentication, correlates API responses, and receives private events', async t => {
  let authorization, peer;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  server.on('connection', (socket, request) => {
    peer = socket; authorization = request.headers.authorization;
    socket.on('message', raw => { const request = JSON.parse(raw); socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { message_id: 2468 } })); });
  });
  const client = new OneBotClient({ onebotUrl: `ws://127.0.0.1:${server.address().port}`, onebotToken: config.onebotToken });
  t.after(async () => { client.stop(); peer?.terminate(); await new Promise(resolve => server.close(resolve)); });
  const connected = once(client, 'connected'); client.start(); await connected;
  assert.equal(authorization, 'Bearer ' + config.onebotToken);
  assert.equal((await client.send('100000002', '[CQ:at,qq=all] literal')).message_id, 2468);
  const incoming = once(client, 'event'); peer.send(JSON.stringify(event(999, '真实协议事件')));
  assert.equal((await incoming)[0].message_id, 999);
});
