# ReMind

> remember what matters

ReMind 是一款移动端优先、本地优先的个人知识 App。它让用户先用最低压力
记下文字或发送链接，再把文章、图文和视频整理成可审核、可追溯、能够持续
补充长期主题的普通 Markdown 笔记。

ReMind 不把 AI 摘要当作最终产品。它更关心三件事：

1. 原始内容能否先可靠保存；
2. 整理结果能否回到真实来源；
3. 每次新输入能否让已有主题变得更完整，而不是只增加一张摘要卡片。

## 当前阶段

- App 版本：`1.0.2`
- Android package：`app.remind.notes`
- iOS bundle identifier：`app.remind.notes`
- Expo SDK：`54`
- 本地数据库：`remind.db`，SQLite schema version `16`
- Android 独立安装版已完成真机安装和 Expo Go 数据迁移
- 微信登录、设备重新配对、Worker、网关和本地 API 当前均可用
- 当前仍是个人原型：手机依赖同一局域网内保持登录且未休眠的 Mac

面向其他用户的本地自托管预览版说明见
[`docs/PUBLIC_LOCAL_RELEASE.md`](docs/PUBLIC_LOCAL_RELEASE.md)。公共版本要求每位用户配置
自己的 DeepSeek Key；智谱 Key 可选。任何模型或微信凭据都不会写入 APK。

## 已经跑通的完整闭环

```text
微信发送文字、公众号或小红书链接
            ↓
    ReMind 微信网关读取来源
            ↓
 Cloudflare Worker / D1 暂存与处理
            ↓
 Android App 同步到本地 SQLite
            ↓
 DeepSeek 生成可审核的来源笔记
            ↓
 用户编辑、确认或拒绝
            ↓
归入持续生长的长期主题，并精选同步到 Obsidian
```

原始捕获永远先保存。网页读取、模型调用、视频转写或 Obsidian 同步失败，
都不会删除用户最初发送的内容。

## 已完成功能

### 1. 本地优先的移动笔记

- 首页直接输入，无需先选文件夹或内容类型。
- SQLite 离线保存、全文搜索、编辑、软删除和最近删除恢复。
- 按收件箱、全部、ReMind、微信、整理笔记、链接和主题分类查看。
- 首页卡片显示清理过 Markdown 标记的两行摘要。
- 深链 `remind://capture` 支持快速记录并按入口 ID 去重。
- “库 → 数据迁移”支持 JSON 导出和合并导入。

### 2. 微信低压力捕获

- 独立微信 iLink / ClawBot 网关，不要求用户安装 OpenClaw。
- 支持微信文字、普通链接、公众号链接和小红书分享文本。
- 支持“链接 + 保存意图”一起发送，也支持先发链接、再补充说明。
- App 使用六位短时码与微信网关配对。
- 微信回复可选择首次确认、每次确认或完全静默。
- 微信消息按原始消息 ID 去重。

### 3. 可审核的 AI 整理

- DeepSeek 调用位于 Worker，模型密钥不进入 App。
- 原始记录保存不等待 AI。
- “整理今天”最多生成三篇可编辑整理稿。
- 链接必须先有用户自己的保存意图，只有 URL 时不会立即调用模型。
- 用户可以修改标题和正文，再决定接受或丢弃。
- 模型认证、限流、超时、内容校验和来源读取失败使用不同错误状态。
- 已有页面快照或视频转写会复用，重新生成不会重复进行高成本处理。

### 4. 可追溯的来源笔记

- 网页正文先切分为稳定证据块，模型只选择证据 ID。
- Worker 根据 ID 取回逐字原文和字符位置，未知证据不能通过校验。
- 审核页分开展示：
  - 用户为什么保存；
  - 整理后的观点；
  - 对应的原始证据；
  - 可打开的原文链接。
- 正式来源笔记生成后，原始链接从普通信息流自动归档但不删除。
- 删除正式来源笔记后，失去引用的原始捕获会重新出现，避免来源失联。

### 5. 持续生长的主题笔记

- 新来源会评估已有主题，匹配可信时建议补充，明显不相关时建议新建。
- 用户不需要记住过去有哪些主题，也可以覆盖模型判断。
- 用户可以选择已有主题，或输入名称创建新主题。
- 每个来源只归属于一个主题，重复接受不会重复追加。
- 模型只生成局部 patch，不重写整篇长期笔记。
- 主题主页将“当前理解”和每篇来源贡献分开：
  - 顶部展示可编辑的当前理解；
  - 下方按来源显示可折叠卡片；
  - 可打开当时的完整整理笔记或原始网页；
  - 可把来源安全移动到其他主题。
- 主题名称、正文和当前理解都可由用户编辑。

### 6. 相关记忆与主动回想

- 来源详情最多展示三条过去的相关整理笔记。
- 同主题来源优先，不足时使用共同标签和稳定关键词补充。
- 每条推荐说明关联原因、时间和来源。
- 首页每天最多展示一条“最近值得再看”。
- 打开过的内容七天内不重复；选择“暂时不看”后三十天内不再出现。

### 7. 小红书图文与视频摄取

图文链接：

- 跟随 `xhslink.cn` 短链，提取标题、作者文案和最多十二张配图。
- 智谱视觉模型分析最多八张图片，失败时仍可依靠标题和文案继续整理。
- 图片观察与网页逐字证据严格分离，不能冒充作者原话。
- App、SQLite、D1 和 Obsidian 不保存图片文件，只保留提炼结果和原始链接。

视频链接：

- 识别视频和时长，临时媒体地址不进入 D1。
- FFmpeg 临时提取并切分音轨。
- 优先使用本机 MLX Whisper；不可用或失败时由智谱 ASR 兜底。
- 转写保存时间位置，供整理结果回到视频上下文。
- 临时视频和音频无论成功或失败都会删除。
- 网关串行处理并上报分段进度，App 展示当前阶段和进度。
- 本地失败且云端估价超过默认 ¥0.30 上限时，先等待用户确认。
- 不默认调用整段视频视觉理解，避免不必要的费用。

### 8. Obsidian 开放出口

- Android 可授权 Obsidian Vault。
- ReMind 单向写入 `ReMind/Inbox` 下的标准 Markdown。
- 使用稳定 `remind_id`、内容 hash 和导出状态去重、更新与重试。
- 原始琐碎记录默认不进入 Obsidian。
- 用户手动选择的笔记和确认后的整理笔记进入同步流程。
- 删除 ReMind 笔记不会直接删除 Obsidian 文件。
- 主题名称、正文和“当前理解”更新同一个 Markdown 文件，不制造重复文件。

### 9. 独立运行与数据安全

- Android APK 内置 JavaScript bundle，不依赖 Expo Go、Metro 或 Codex。
- Worker 和微信网关由 macOS LaunchAgent 托管，登录后自动启动并在异常退出后恢复。
- DeepSeek、智谱和微信令牌保存在 macOS 钥匙串，不提交到项目。
- SQLite 用户内容可导出为 JSON；相同主键导入时跳过，不覆盖或制造重复。
- 备份不包含 SecureStore 密钥和 Android 目录授权，避免敏感信息外泄。

## 视觉方向

ReMind 避免高饱和渐变、机器人头像和“AI 驾驶舱”式界面。

- 主品牌只使用 `ReMind`，当前不展示中文副品牌。
- 奶油白背景搭配灰绿、雾蓝、淡杏和浅紫纸卡。
- 卡片使用细小书签色、纸张层级和克制的手绘边框。
- 标题强调阅读感，正文优先保证长内容可读性。
- 用户界面使用“整理稿”“归入长期主题”等笔记语言，弱化模型名称。

## 技术结构

```text
remind/
├── App.tsx
├── src/
│   ├── ReMindApp.tsx          # 主要界面与交互
│   ├── database.ts            # SQLite migrations 与数据访问
│   ├── ai-organize.ts         # App → Worker 整理请求
│   ├── wechat-sync.ts         # 设备注册、配对与收件
│   ├── obsidian-sync.ts       # Android Vault 同步
│   ├── obsidian-markdown.ts   # Markdown / frontmatter 输出
│   └── data-backup.ts         # JSON 数据迁移
├── server/
│   ├── src/                   # Cloudflare Worker
│   └── migrations/            # D1 0001–0011
├── gateway/
│   └── src/                   # 微信、页面读取、视频转写与后台队列
├── scripts/
│   └── remind-services.mjs    # macOS LaunchAgent 管理
└── docs/
```

主要依赖：

- Expo 54、React Native 0.81、TypeScript
- `expo-sqlite`、`expo-secure-store`、`expo-file-system`
- Cloudflare Worker、D1
- DeepSeek
- 智谱视觉模型与语音识别
- FFmpeg、MLX Whisper
- 腾讯微信 iLink / ClawBot
- Obsidian Markdown

## 在当前开发机上运行

项目路径：

```text
/Users/stone/Documents/remind
```

查看后台状态：

```bash
npm run services:status
```

常用命令：

```bash
npm run services:install
npm run services:restart
npm run services:logs
```

开发时启动 Expo：

```bash
npm start
```

当前 Android 安装包连接：

```text
http://192.168.31.122:8787
```

因此手机和 Mac 需要处于同一局域网，Mac 需要保持登录且未休眠。电脑 IP
变化后，当前安装包无法自动发现新地址，需要更新配置并重新构建。

## 开发检查

```bash
# App
npm run typecheck
npx expo export --platform android --output-dir /tmp/remind-android-export
npx expo export --platform ios --output-dir /tmp/remind-ios-export

# Worker
cd server
npm run check

# Gateway
cd gateway
npm run typecheck
npm test
```

当前基线：

- Worker：25 项测试通过
- Gateway：10 项测试通过
- Android export：通过
- Worker deploy dry-run：通过

## 下一阶段优先级

### P0：完成当前版本真机回归

- 在新版重新授权 Obsidian，并验证精选笔记和主题笔记更新。
- 从微信重发公众号、普通网页、小红书图文和视频各一条。
- 完整验证“捕获 → 处理 → 审核 → 主题 → Obsidian”。
- 核验相关记忆、最近值得再看和原始链接归档。

### P1：微信自助配对

- App 增加“连接这台电脑”。
- 自动连接同一局域网内的 ReMind 网关并提交短时配对码。
- 不再要求 Codex 或终端命令。
- 配对后自动刷新状态，无需手动重启网关。
- 增加来源限制、限流、过期处理和手动兜底。

### P1：真正的系统分享入口

- Android Share Intent 接收 `text/plain`。
- iOS Share Extension 接收文本和 URL。
- 离线写入共享存储，主 App 启动后去重导入。

### P1：摆脱固定局域网 IP

- 为本机网关增加安全的自动发现或稳定入口。
- 区分个人本机模式与未来云端模式。
- App 提供可理解的离线、电脑休眠和网络变化提示。

### P2：质量与可维护性

- 将体积较大的 `ReMindApp.tsx` 按 capture、notes、review、themes、settings 拆分。
- 为网络恢复增加有限重试、指数退避和更完整的任务历史。
- 增加崩溃监控、隐私说明、数据删除和密钥轮换流程。
- 建立安全的 Git 基线；当前仓库尚未形成可回退的首个正式提交。

### P2：长期产品能力

- 播客、PDF、语音和文件摄取，并保留时间戳或页码证据。
- Ask ReMind：只根据用户笔记回答，并展示引用。
- 周记、月章、待办提取和用户可控的主动回想。
- 账户、跨设备同步和冲突版本保留。

## 当前限制

- 这是个人可用原型，不是多用户生产服务。
- 微信网关和本地 Whisper 依赖个人 Mac。
- 当前 Android APK 使用固定局域网地址。
- iOS 的 Obsidian 导出和系统分享尚未完成。
- 小红书和公众号读取依赖非官方页面结构，需要持续维护适配器。
- 相关记忆和主题匹配主要使用可解释的本地规则与模型判断，尚未接入向量检索。

## 进一步阅读

- [移动端 MVP 与完成清单](./docs/REMIND_MVP.md)
- [ReMind → Obsidian 同步设计](./docs/OBSIDIAN_SYNC.md)
- [阶段产品亮点与自媒体文案](./docs/PRODUCT_HIGHLIGHTS.md)
- [最新项目交接说明](./docs/PROJECT_HANDOFF_2026-07-28.md)
- [上一阶段详细开发记录](./docs/PROJECT_HANDOFF_2026-07-27.md)
