'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function configure(args, root = __dirname) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--qq', '--controller', '--thread', '--name', '--onebot-port', '--status-port', '--qq-exe'].includes(args[index]) || args[index + 1] == null) throw Error('请提供有效的配置参数');
    values[args[index].slice(2)] = args[index + 1];
  }
  if (!/^\d{5,12}$/.test(values.qq || '') || !/^\d{5,12}$/.test(values.controller || '') || values.qq === values.controller) throw Error('需要不同的接收 QQ 号码和控制联系人号码');
  if (!/^[a-f0-9-]{36}$/i.test(values.thread || '')) throw Error('需要本机 Codex 对话编号');
  const file = path.join(root, 'data', 'config.json');
  if (fs.existsSync(file)) throw Error('配置文件已存在，请编辑 data/config.json');
  const onebotPort = Number(values['onebot-port'] || 3001), statusPort = Number(values['status-port'] || 18789);
  for (const port of [onebotPort, statusPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口应在 1024 到 65535 之间');
  if (onebotPort === statusPort) throw Error('消息端口与状态端口需要不同');
  const config = { accountId: values.qq, allowedUserIds: [values.controller], contactName: values.name || '控制联系人',
    threadId: values.thread, hostId: 'local', onebotUrl: `ws://127.0.0.1:${onebotPort}`,
    onebotToken: crypto.randomBytes(32).toString('hex'), controlToken: crypto.randomBytes(32).toString('hex'),
    statusPort, qqExecutable: values['qq-exe'] || '', pollMs: 3000, maxMessageChars: 16000,
    replyChunkChars: 1500, queueLimit: 40, deliverablesRoot: path.join(root, 'outputs') };
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(config.deliverablesRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
if (require.main === module) {
  try { console.log('已创建 ' + configure(process.argv.slice(2)) + '\n请将其中的 onebotToken 配置到 NapCat 的本机正向 WebSocket 服务。'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { configure };
