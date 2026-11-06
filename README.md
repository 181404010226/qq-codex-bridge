# QQ Codex Bridge

在 QQ 私聊里给电脑上的 Codex 发任务。新消息可以即时引导正在执行的轮次，最终回答自动回到同一个 QQ 私聊。

## 功能

- 绑定接收 QQ、控制联系人白名单和一个本机 Codex 长期对话。
- 图片与普通文件下载到独立目录后进入对话，文字消息可在附件准备期间继续投递。
- 按消息编号去重，SQLite 保存投递状态、附件任务和回传记录。
- 同一轮多条引导合并回传最终回答，较长文字自动分段。
- 最终回答中 `outputs/` 内的本机 Markdown 文件链接会自动回传图片或文件。
- Windows 后台守护与手动启停，本机状态页显示连接与任务状态。

## 环境

Windows，Node.js 22.13 或以上，已登录的 Codex 桌面端，以及提供 OneBot 11 正向 WebSocket 的 NapCat QQ。当前实现通过 Codex 桌面的本机 app-tools 管道接入已有对话。不同桌面版本需要具备对应的工具接口。

NapCat 按其项目文档配置本机正向 WebSocket 服务，监听 `127.0.0.1`。本项目使用独立的 OneBot 接口连接。[NapCat 项目](https://github.com/NapNeko/NapCatQQ)

## 安装

```powershell
git clone https://github.com/181404010226/qq-codex-bridge.git
cd qq-codex-bridge
npm ci
node setup.cjs --qq 接收QQ号码 --controller 控制联系人QQ号码 --thread Codex对话编号
```

对话编号可从 Codex 的会话分享或复制链接中取得，格式为 UUID。配置工具生成 `data/config.json` 和两个随机本机令牌。将 `onebotToken` 填入 NapCat 对应 WebSocket 服务的 Access Token，并核对端口。默认消息端口为 3001，状态端口为 18789。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

状态页显示 QQ 与 Codex 已连接后，由白名单联系人发来文字、图片或文件即可使用。单条消息最多 10 个附件，单个附件上限为 50 MiB。图片通过 `view_image` 查看，其他文件按类型调用对话中的读取工具。语音和视频作为文件接入，转写或解析依赖可用工具。

## 常用操作

```powershell
node bridge-cli.cjs notify "测试消息"
node bridge-cli.cjs recover QQ消息编号
node bridge-cli.cjs send-image 控制联系人QQ号码 图片绝对路径
node bridge-cli.cjs send-file 控制联系人QQ号码 文件绝对路径
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
```

QQ 中可使用 `/状态`、`/暂停`、`/恢复`、`/帮助`。需要登录或工具审批时，在对应应用中完成操作。

可选的 `install-autostart.ps1` 为当前 Windows 用户建立开机启动入口。手动停止后，自动恢复保持暂停，执行 `start.ps1` 可恢复。

## 数据与投递

`data/` 保存本机配置、消息队列、附件副本和运行日志，已在 `.gitignore` 中排除。投递回执不确定时，会核对原对话的消息标记。结果无法确认的 QQ 发送会保留待核对状态。

消息仅由配置的接收账号和白名单私聊进入。附件里的文字按文档内容处理。文件回传使用独立快照，重试会继续发送该快照。

QQ 空消息事件在入队前过滤。同一编号后续补齐的正文或附件仍可正常接收。

## 开发

```powershell
npm test
```

测试覆盖账号和联系人过滤、即时引导、同轮回传合并、断线恢复、附件持久化、文件名清理、重复消息和输出快照。

桌面管道连接参考用户提供的 CodexWorkbench 接入思路。运行时依赖 `ws`，通过 npm 安装并遵循其 MIT 许可。

## 许可

项目代码采用 MIT 许可，详见 LICENSE。
