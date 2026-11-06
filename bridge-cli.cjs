'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { OneBotClient } = require('./onebot-client.cjs');
const file = path.join(__dirname, 'data', 'config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const normalize = value => String(value || '').replace(/[\s【】\[\]]/g, '');
const qq = new OneBotClient(config);
const timeout = setTimeout(() => { console.error('QQ 接口尚未连接或操作超时，请查看适配器日志或完成登录。'); qq.stop(); process.exitCode = 1; }, ['recover', 'send-image', 'send-file'].includes(process.argv[2]) ? 90000 : 15000);
qq.once('connected', async () => {
  try {
    const login = await qq.call('get_login_info');
    if (String(login.user_id) !== String(config.accountId)) throw Error('QQ 登录账号与配置不符');
    if (['probe', 'bind'].includes(process.argv[2])) {
      const friends = await qq.call('get_friend_list');
      const matches = friends.filter(f => [f.remark, f.nickname].some(name => normalize(name) === normalize(config.contactName)));
      if (matches.length !== 1) throw Error(`联系人匹配到 ${matches.length} 人，请按 QQ 号码人工核对`);
      const contact = matches[0];
      if (process.argv[2] === 'bind') {
        config.allowedUserIds = [String(contact.user_id)];
        config.controlToken ||= crypto.randomBytes(32).toString('hex');
        const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
      }
      console.log(JSON.stringify({ accountId: String(login.user_id), nickname: login.nickname,
        contact: { userId: String(contact.user_id), nickname: contact.nickname, remark: contact.remark }, bound: process.argv[2] === 'bind' }, null, 2));
    } else if (process.argv[2] === 'recover') {
      const messageId = process.argv[3];
      const result = await new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ messageId }));
        const request = http.request({ hostname: '127.0.0.1', port: config.statusPort, path: '/recover-message', method: 'POST',
          headers: { Authorization: 'Bearer ' + config.controlToken, 'Content-Type': 'application/json', 'Content-Length': body.length } }, response => {
          let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
          response.on('end', () => { try { const value = JSON.parse(text); if (response.statusCode !== 200) throw Error(value.error); resolve(value); } catch (error) { reject(error); } });
          response.on('error', reject);
        });
        request.setTimeout(60000, () => request.destroy(Error('消息恢复超时'))); request.on('error', reject); request.end(body);
      });
      console.log(JSON.stringify(result));
    } else if (['send-image', 'send-file'].includes(process.argv[2])) {
      const userId = String(process.argv[3]), file = path.resolve(process.argv[4] || '');
      if (!config.allowedUserIds?.map(String).includes(userId) || !fs.statSync(file).isFile()) throw Error('需要白名单收件人及可读取的本机文件');
      const result = process.argv[2] === 'send-image' ? await qq.sendImage(userId, file) : await qq.sendFile(userId, file);
      console.log(JSON.stringify({ userId, messageId: String(result.message_id) }));
    } else if (process.argv[2] === 'notify') {
      const text = process.argv[3];
      if (!text || !config.allowedUserIds?.length) throw Error('需要通知内容及已绑定联系人');
      for (const userId of config.allowedUserIds) {
        const result = await qq.send(userId, text);
        console.log(JSON.stringify({ userId, messageId: String(result.message_id) }));
      }
    } else throw Error('用法 node bridge-cli.cjs probe | bind | notify 文字 | recover 消息编号 | send-image QQ 图片路径 | send-file QQ 文件路径');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(timeout); qq.stop(); }
});
qq.start();
