# ReMind Local

ReMind Local 是一个面向 Android 与 macOS 的本地自托管记忆工具。手机负责记录，Mac
负责链接读取、AI 整理和可选的微信接收；普通笔记和图片记录始终保存在手机本地。

这是 `1.0.3 preview.1`，适合愿意自己维护本地服务并保留数据备份的用户。

## 主要能力

- 文字、图片和链接记录；
- 搜索、整理、主题、问答与回望；
- 图片记录直接从首页“+”进入；
- Obsidian 导出与同步；
- App 内配置并检查自己的 Mac 服务地址；
- 可选微信扫码连接与消息捕获。

## 安装

1. 从 [Releases](https://github.com/stoneQ-Q/ReMind-Local/releases) 下载 APK；
2. 在 Android 手机上安装 `ReMind-Local-*.apk`；
3. 在 Mac 下载同一版本的源代码并解压；
4. 安装 Node.js 22 或更高版本；
5. 双击 `setup-local.command`，在本机浏览器中填写自己的 DeepSeek API Key；
6. 把设置页显示的 Mac 地址填入 App 的“连接自己的 Mac”。

完整说明见 [公共本地版安装文档](docs/PUBLIC_LOCAL_RELEASE.md)。

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
