# ReMind Local

ReMind Local 是一个面向 Android 与 macOS 的本地自托管记忆工具。它最重要的记录入口
是微信：连接 ClawBot 后，大多数时候不需要打开 ReMind App，直接在微信里发送文字、
语音或链接，就能把当时的想法留下来。App 主要用于图片记录、查看、整理、搜索和回望，
Mac 负责微信接收、链接读取和 AI 整理；普通笔记和图片记录保存在手机本地。

这是 `1.0.3 preview.1`，适合愿意自己维护本地服务并保留数据备份的用户。

## 主要能力

- 以微信 ClawBot 为核心记录入口，不打开 App 也能持续记录；
- 接收微信中的文字、语音和链接；
- 在 App 中记录文字、拍照或从相册选择 1–4 张图片；
- 搜索、整理、主题、问答与回望；
- Obsidian 导出与同步；
- App 内配置并检查自己的 Mac 服务地址；
- 微信扫码连接、同步状态和回复方式设置。

## 怎么使用 ReMind

### 平时记录：直接发给微信 ClawBot

完成下方的微信连接后，可以把 ClawBot 当作一个随时都在的记录入口。想到什么，就在
微信里把文字、语音或链接发给它；Mac 上的 ReMind 服务保持运行时，内容会进入 ReMind。
用户不需要为了每条记录专门打开 App。

### 需要打开 App 时

- **记录**：在首页输入文字；点击“+”可以选择图片或拍一张。首页会显示今天记下多少条、
  还有多少条待整理，以及最近记录和本周记忆轨迹。
- **整理今天**：集中查看当天记录，让 AI 生成整理结果，再由用户确认是否保存或归入主题。
- **笔记**：分别查看“整理笔记”“主题”和“原始记录”。微信、App 随手记和分享进入的
  原始内容都会按时间保留。
- **找回**：按关键词搜索过去的记录，也可以使用“问 ReMind”，直接向自己的笔记提问。
- **顶部的“机”**：填写或检查自己的 Mac 本地服务地址。
- **顶部的“库”**：选择 Obsidian Vault、查看同步状态并执行备份。
- **顶部的“微”**：连接微信、检查网关是否在线，并选择首次确认、每次确认或静默记录。

一个推荐的使用节奏是：白天随时在微信里记录，晚上或有空时再打开 ReMind，使用
“整理今天”把零散内容变成笔记；需要回忆时进入“找回”，重要内容再保存到 Obsidian。

## 安装

1. 从 [Releases](https://github.com/stoneQ-Q/ReMind-Local/releases) 下载 APK；
2. 在 Android 手机上安装 `ReMind-Local-*.apk`；
3. 在 Mac 下载同一版本的源代码并解压；
4. 安装 Node.js 22 或更高版本；
5. 双击 `setup-local.command`，在本机浏览器中填写自己的 DeepSeek API Key；
6. 把设置页显示的 Mac 地址填入 App 的“连接自己的 Mac”；
7. 按下一节完成微信 ClawBot 连接，这是 ReMind 的核心记录入口。

完整说明见 [公共本地版安装文档](docs/PUBLIC_LOCAL_RELEASE.md)。

## 连接微信 ClawBot（核心步骤）

微信 ClawBot 是 ReMind 的主要记录入口。完成连接后，大多数日常记录都可以直接在微信中
完成，不需要先打开 ReMind App。微信接收功能基于腾讯公开的
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 登录协议，但
ReMind 使用自己的轻量网关，不要求安装 OpenClaw。当前预览版首次连接需要在 Mac 的
终端中完成扫码和配对；后续版本计划把重新连接流程放进 App。

开始前，请先双击 `setup-local.command` 完成本地服务设置，并在 ReMind 顶部的“机”中
连接自己的 Mac。

1. 在 Mac 打开“终端”，进入下载后的 `ReMind-Local/gateway` 文件夹：

   ```bash
   cd ReMind-Local/gateway
   ```

2. 启动微信登录：

   ```bash
   npm run login
   ```

3. 终端会显示一个二维码。打开手机微信，使用“扫一扫”扫描 Mac 屏幕上的二维码，并在
   微信中确认授权；如果微信显示一组验证数字，按终端提示输入。看到“微信连接成功”后
   再继续。这个过程就是添加并授权 ClawBot，不需要搜索微信号或手动添加好友。
4. 打开 ReMind，点击顶部的“微”，记下页面显示的六位“网关配对码”。配对码 10 分钟
   内有效。
5. 回到 Mac 终端，把下面的 `123456` 换成 App 中显示的六位码：

   ```bash
   REMIND_API_URL=http://127.0.0.1:8787 npm run pair -- 123456
   ```

6. 看到“ReMind 配对成功”后，回到项目根目录并安装后台网关：

   ```bash
   cd ..
   npm run services:install
   npm run services:status
   ```

7. 回到 ReMind 的微信页面，点击“我已配对，检查状态”。显示“同步已开启”后，即可在
   微信的 ClawBot 会话中发送文字、语音或链接，记录会同步进入 ReMind。

微信登录凭据和 ReMind 连接器密钥只保存在用户 Mac 的
`~/.remind-weixin/config.json`，请勿分享、上传或提交该文件。当前网关只接收扫码账号
本人发给 ClawBot 的私聊消息。Mac 关机、休眠或微信网关停止时，同步会暂停；已经进入
手机的记录不受影响。

## 不会安装时，让 Codex 或其他 Agent 协助

如果不熟悉终端，可以使用 Codex，或其他能够读取本地文件并运行终端命令的编程 Agent
协助安装。把本项目的官方 GitHub 地址复制给 Agent：

```text
https://github.com/stoneQ-Q/ReMind-Local
```

然后可以直接复制下面这段话发给它：

```text
请帮我从 https://github.com/stoneQ-Q/ReMind-Local 安装 ReMind Local。
请先确认下载来源是 stoneQ-Q/ReMind-Local，并阅读 README 和安装文档。
帮我检查并安装所需的 Node.js 版本和项目依赖，运行本地设置程序，
再检查 ReMind 本地服务是否正常。不要读取、打印、上传或提交我的 API Key；
需要填写 API Key 时，请打开本机设置页面让我自己输入。
本地服务连接成功后，请继续帮我连接微信 ClawBot，运行到显示二维码和六位码配对的步骤，
扫码、微信确认和验证码由我本人完成。每一步完成后请用简单中文告诉我结果。
```

Agent 可以帮助完成下载代码、准备依赖、启动服务、检查状态，以及在已连接的 Android
手机上安装 APK；但用户仍应亲自完成 API Key 输入、微信扫码、账号授权和手机上的安全
确认。不要把 API Key、微信登录文件或其他凭据粘贴到聊天中，也不要允许 Agent 将这些
内容上传到 GitHub。安装前请确认仓库所有者和地址完全一致，避免使用来历不明的副本。

## iPhone 与 TestFlight

目前公开版本只提供 Android APK，尚未提供可安装的 iPhone 版本。项目已经通过 iOS
代码导出检查，但维护者目前没有 iOS 设备，因此还没有完成 iPhone 真机测试，不应把当前
版本视为已支持 iOS。

未来发布 iOS 测试版后，用户可以：

1. 从 App Store 安装 TestFlight；
2. 打开 ReMind 提供的 TestFlight 邀请链接；
3. 在 TestFlight 中安装并更新 ReMind。

用户不需要 Apple 开发者账号，也不需要向 ReMind 提供设备 UDID。TestFlight 中的每个
测试构建最多可使用 90 天，维护者需要在过期前发布新构建。当前本地模式即使发布 iOS
版本，仍需要用户自己的 Mac 和 API Key；后续计划提供 ReMind 自有云服务。

## 离开同一局域网时使用（可选）

默认情况下，手机和 Mac 需要连接同一个局域网。如果希望在外出、使用手机流量或连接其他
Wi-Fi 时继续访问自己的 Mac，可以自行安装
[Tailscale](https://tailscale.com/download)。这不是 ReMind 的必需组件，也不由 ReMind
提供或维护。

1. 在 Mac 和 Android 手机上分别安装 Tailscale；
2. 两台设备登录同一个 Tailscale 账号，并确认都处于在线状态；
3. 保持 Mac 上的 ReMind 本地服务运行；
4. 在 Tailscale 中查看 Mac 的设备名称或 `100.x.x.x` 地址；
5. 打开 ReMind 顶部的“机”，在“连接自己的 Mac”中填写
   `Mac设备名称:8787` 或 `100.x.x.x:8787`；
6. 点击“检查并连接”。

使用这种方式时，API Key 仍只保存在用户自己的 Mac 上。Mac 休眠、关机、断网或
Tailscale 离线时，需要电脑端处理的功能仍会暂停。请勿为了远程连接而直接开放路由器
端口或把 `8787` 端口暴露到公网。

后续版本计划提供由 ReMind 托管的云服务，让不想维护 Mac 或额外网络工具的用户也能在
不同网络下使用。

## API Key 与数据边界

- 每位用户使用自己的 DeepSeek Key；智谱 Key 可选；
- Key 只保存在用户 Mac 的 `~/.remind/secrets.env`；
- APK、GitHub 仓库和 Android App 都不包含模型 Key；
- 公共 APK 不预设维护者的局域网地址或云端服务地址；
- GitHub Actions 只使用维护者自己的 Expo 登录令牌读取 Android 签名凭据，不接触模型
  API Key。

## 本地验证

```bash
npm ci
npm run release:check
npm run typecheck
npm test -- --run
```

本地 Worker 与微信网关分别位于 `server/` 和 `gateway/`。

## 当前限制

- 目前只提供 Android App；本地服务主机只支持 macOS；
- 手机和 Mac 需要位于同一局域网；
- Mac 休眠或服务停止时，AI、链接处理和微信同步会暂停；
- 微信首次登录仍需要额外扫码和配对；
- 预览版不应作为唯一数据副本，请保留 Obsidian 或其他备份。

## License

[MIT](LICENSE)
