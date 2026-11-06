'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { QQBridge } = require('../qq-bridge.cjs');
const { BridgeStore } = require('../bridge-store.cjs');
const { AttachmentManager, attachmentSegments, safeName, outgoingFiles } = require('../attachments.cjs');

const config = { accountId: '100000001', allowedUserIds: ['100000002'], contactName: '控制联系人',
  threadId: '11111111-1111-4111-8111-111111111111', hostId: 'local',
  onebotToken: 'a'.repeat(64), controlToken: 'b'.repeat(64), maxMessageChars: 16000, queueLimit: 40, replyChunkChars: 1500 };
const event = (id, message) => ({ post_type: 'message', message_type: 'private', self_id: 100000001, user_id: 100000002,
  sender: { user_id: 100000002 }, message_id: id, time: Math.floor(Date.now() / 1000), message });
const segment = (type, file = type + '-id', extra = {}) => ({ type, data: { file, ...extra } });
async function settled(f) {
  const deadline = Date.now() + 4000;
  while (f.manager.busy || f.bridge.delivering || f.bridge.sending || f.bridge.busy) {
    if (Date.now() > deadline) throw Error('fixture did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setImmediate(resolve));
}
function fixture(t) {
  const parent = process.env.BRIDGE_TEST_TMP || os.tmpdir(); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'qq-attachments-')), root = path.join(directory, 'bridge'); fs.mkdirSync(root);
  const source = path.join(directory, '本机 附件.txt'); fs.writeFileSync(source, '附件中的中文内容\n第二行\n');
  const image = path.join(directory, 'screen.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZUAAAAASUVORK5CYII=', 'base64'));
  const store = new BridgeStore(path.join(root, 'queue.sqlite')), qq = new EventEmitter();
  qq.sent = []; qq.calls = [];
  qq.call = async (action, params) => {
    qq.calls.push({ action, params });
    if (action === 'get_login_info') return { user_id: 100000001 };
    return { file: action === 'get_image' ? image : source, file_name: action === 'get_image' ? '截图.png' : '../中文 文件.txt' };
  };
  qq.send = async (userId, text) => { qq.sent.push({ kind: 'text', userId, text }); return { message_id: qq.sent.length }; };
  qq.sendImage = async (userId, file) => { qq.sent.push({ kind: 'image', userId, file }); return { message_id: qq.sent.length }; };
  qq.sendFile = async (userId, file) => { qq.sent.push({ kind: 'file', userId, file }); return { message_id: qq.sent.length }; };
  qq.stop = () => {}; qq.start = () => {};
  const desktop = { sent: [], response: { thread: { id: config.threadId }, turns: [] },
    read: async function() { return this.response; }, send: async function(prompt) { this.sent.push(prompt); return { threadId: config.threadId }; } };
  const bridge = new QQBridge({ config: { ...config, root }, store, qq, desktop }); bridge.accountVerified = true;
  const manager = new AttachmentManager({ root, store, qq, onReady: () => bridge.deliverPending() }); bridge.attachments = manager;
  const f = { directory, root, source, image, store, qq, desktop, bridge, manager };
  t.after(async () => { bridge.stop(); await settled(f); store.close(); });
  return f;
}

test('attachment parsing preserves opaque ids and sanitizes filenames', () => {
  assert.equal(attachmentSegments({ message: [segment('image'), segment('file'), segment('record'), segment('video'), segment('json')] }).length, 4);
  assert.equal(safeName('..\\..\\secret.txt'), 'secret.txt'); assert.equal(safeName('CON.txt'), 'attachment');
});

test('QQ image is copied into durable storage and sent as immediate readable guidance once', async t => {
  const f = fixture(t), message = event(1, [segment('image')]);
  await f.bridge.receive(message); await f.bridge.receive(message); await settled(f);
  const row = f.store.get('100000001:100000002:1'), files = f.manager.files(row.id);
  assert.equal(files.length, 1); assert.equal(files[0].state, 'ready');
  assert.equal(files[0].mime, 'image/png'); assert.notEqual(files[0].local_path, f.image);
  assert.deepEqual(fs.readFileSync(files[0].local_path), fs.readFileSync(f.image));
  assert.equal(f.desktop.sent.length, 1); assert.match(f.desktop.sent[0], /view_image/);
  assert.ok(f.desktop.sent[0].includes(JSON.stringify(files[0].local_path)));
  assert.equal(f.qq.sent.filter(row => row.text?.startsWith('附件已收到')).length, 1);
});

test('an image populated after an empty event retains its original message id and downloads normally', async t => {
  const f = fixture(t);
  await f.bridge.receive({ ...event(11, []), raw_message: '' });
  await f.bridge.receive(event(11, [segment('image')]));
  await settled(f);
  assert.equal(f.desktop.sent.length, 1);
  assert.equal(f.manager.files(`${config.accountId}:${config.allowedUserIds[0]}:11`)[0].state, 'ready');
});

test('caption and multiple same-name files retain separate durable attachments', async t => {
  const f = fixture(t);
  await f.bridge.receive(event(2, [{ type: 'text', data: { text: '读一下这两个文件' } }, segment('file', 'a'), segment('file', 'b')]));
  await settled(f);
  const files = f.manager.files('100000001:100000002:2');
  assert.equal(files.length, 2); assert.notEqual(files[0].local_path, files[1].local_path);
  assert.equal(files[0].name, '中文 文件.txt'); assert.equal(fs.readFileSync(files[0].local_path, 'utf8'), '附件中的中文内容\n第二行\n');
  assert.match(f.desktop.sent[0], /读一下这两个文件/);
});

test('a slow attachment does not delay subsequent text guidance', async t => {
  const f = fixture(t); let finish;
  f.qq.call = () => new Promise(resolve => { finish = resolve; });
  await f.bridge.receive(event(3, [segment('file')]));
  await f.bridge.receive(event(4, [{ type: 'text', data: { text: '先处理这条文字' } }]));
  assert.equal(f.desktop.sent.length, 1); assert.match(f.desktop.sent[0], /先处理这条文字/);
  finish({ file: f.source, file_name: 'file.txt' }); await settled(f);
  assert.equal(f.desktop.sent.length, 2);
});

test('unauthorized senders and wrong receiving accounts cannot trigger downloads', async t => {
  const f = fixture(t);
  await f.bridge.receive({ ...event(5, [segment('image')]), user_id: 12345 });
  await f.bridge.receive({ ...event(6, [segment('file')]), self_id: 12345 });
  assert.equal(f.qq.calls.length, 0); assert.equal(f.store.recent().length, 0);
});

test('legacy media-only acknowledgement can be recovered without duplicate execution', async t => {
  const f = fixture(t), message = event(7, [segment('image')]);
  f.store.accept(message, '', 'control');
  await f.bridge.receive(message); await settled(f); await f.bridge.receive(message); await settled(f);
  assert.equal(f.desktop.sent.length, 1); assert.equal(f.manager.files('100000001:100000002:7').length, 1);
});

test('offline-file notices use the same authenticated attachment path', async t => {
  const f = fixture(t);
  await f.bridge.receive({ self_id: 100000001, user_id: 100000002, post_type: 'notice', notice_type: 'offline_file',
    time: Math.floor(Date.now() / 1000), file: { id: 'opaque-file-id', name: 'notice.txt', size: 10 } });
  await settled(f);
  assert.equal(f.desktop.sent.length, 1); assert.equal(f.qq.calls[0].action, 'get_file');
});

test('transient download errors survive restart and resume without another incoming event', async t => {
  const f = fixture(t); const original = f.qq.call;
  f.qq.call = async () => { throw Error('failed https://secret/?token=private'); };
  await f.bridge.receive(event(8, [segment('file')])); await settled(f);
  const row = f.manager.files('100000001:100000002:8')[0];
  assert.equal(row.state, 'pending'); assert.ok(!row.error.includes('secret'));
  f.manager.stop(); f.qq.call = original;
  const replacement = new AttachmentManager({ root: f.root, store: f.store, qq: f.qq, onReady: () => f.bridge.deliverPending() });
  f.bridge.attachments = replacement; f.manager = replacement;
  f.store.db.prepare('UPDATE attachments SET retry_at=0').run(); await replacement.poll(); await settled(f);
  assert.equal(f.desktop.sent.length, 1); assert.equal(replacement.files(row.inbound_id)[0].state, 'ready');
});

test('oversize data fails explicitly while keeping its caption available', async t => {
  const f = fixture(t); f.manager.maxBytes = 2;
  await f.bridge.receive(event(9, [{ type: 'text', data: { text: '分析附件' } }, segment('file')])); await settled(f);
  const file = f.manager.files('100000001:100000002:9')[0];
  assert.equal(file.state, 'failed'); assert.match(f.desktop.sent[0], /读取失败/); assert.match(f.desktop.sent[0], /分析附件/);
});

test('final deliverable links enqueue image/file sends once with the correlated answer', async t => {
  const f = fixture(t); f.bridge.config.autoSendLocalFiles = true; f.bridge.config.deliverablesRoot = f.directory;
  await f.bridge.receive(event(10, [{ type: 'text', data: { text: '给我结果文件' } }]));
  const row = f.store.get('100000001:100000002:10');
  f.desktop.response.turns = [{ id: 'final-turn', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: row.marker }] },
    { type: 'agentMessage', phase: 'final_answer', text: `[文件](<${f.source}>)\n![图片](${f.image})` },
  ] }];
  await f.bridge.tick(); await f.bridge.tick(); await settled(f);
  assert.equal(f.qq.sent.filter(row => row.kind === 'file').length, 1); assert.equal(f.qq.sent.filter(row => row.kind === 'image').length, 1);
});

test('automatic output selection excludes remote links and files outside the deliverables root', t => {
  const f = fixture(t);
  assert.equal(outgoingFiles(`[outside](${f.source})\n[web](https://example.com/file.pdf)`, f.root).length, 0);
  assert.equal(outgoingFiles(`[file](<${f.source}>)\n[again](<${f.source}>)`, f.directory).length, 1);
});

test('outgoing retries retain the original file snapshot after the source is edited', async t => {
  const f = fixture(t), original = fs.readFileSync(f.source);
  const files = [{ path: f.source, name: 'report.txt', kind: 'file' }];
  const first = await f.manager.stageOutgoing(files, 'turn-output');
  fs.writeFileSync(f.source, 'later edit');
  const again = await f.manager.stageOutgoing(files, 'turn-output');
  assert.equal(first[0].path, again[0].path); assert.deepEqual(fs.readFileSync(again[0].path), original);
});
