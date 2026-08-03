# ReMind Local 公共预览版

ReMind Local 是 Android + macOS 的本地自托管预览版。Android 手机保存笔记，Mac
运行链接读取、AI 整理和可选微信网关。每位用户使用自己的 API Key，项目维护者不提供、
转发或共享任何模型凭据。

## 数据与密钥边界

- Android APK 不包含 DeepSeek、智谱或微信 Key；
- 公共 APK 不预设维护者的局域网地址或私密云端地址；
- DeepSeek Key 由用户在自己的 Mac 上配置，用于整理、问答与回望；
- 智谱 Key 可选，仅用于需要的视觉能力或云端语音兜底；
- 本地设置页把 Key 写入 `~/.remind/secrets.env`，目录权限为 `700`，文件权限为 `600`；
- 完整 Key 不回显、不写入日志、不上传 GitHub，也不传给 Android App；
- App 只把用户确认可达的 Mac 服务地址保存到 Android SecureStore。

## 当前支持范围

- Android 设备；
- macOS 作为本地服务主机；
- 手机与 Mac 位于同一局域网；
- 普通记录、图片记录、搜索、整理、主题、问答、回望与 Obsidian；
- 微信捕获需要用户使用自己的微信完成额外扫码与配对。

当前仍是预览版。Mac 休眠、离开同一网络或本地服务停止时，手机里的普通记录和搜索仍可
使用，但 AI、链接处理和微信同步会暂时不可用。

## 用户安装

1. 从 GitHub Release 下载并安装 `ReMind-Local-*.apk`；
2. 在 Mac 下载同一 Release 的源代码包并解压；
3. 双击 `setup-local.command`；
4. 浏览器会打开仅监听 `127.0.0.1` 的本地设置页；
5. 填写自己的 DeepSeek API Key，可选填写智谱 API Key；
6. 设置页完成检查并启动服务后，会显示类似 `http://192.168.1.8:8787` 的地址；
7. 在 App 中打开“连接方式”，将该地址填入“连接自己的 Mac”，点击“检查并连接”。

## 构建公共 APK

公共构建使用独立 EAS profile：

```bash
npm run release:check
npx eas-cli build --platform android --profile public-local
```

该 profile 的固定边界：

- App 名称：`ReMind Local`；
- 版本：`1.0.3`；
- Android package：`app.remind.notes.local`；
- 构建配置与所用 EAS 环境均不声明 `EXPO_PUBLIC_REMIND_LOCAL_API_URL`；
- 构建配置与所用 EAS 环境均不声明 `EXPO_PUBLIC_REMIND_CLOUD_API_URL`；
- 输出为可直接安装的 APK。

## 发布前安全检查

每次 GitHub Release 前必须完成：

1. `npm run release:check`；
2. App、server、gateway 的 TypeScript 与测试；
3. Android 公共 profile 导出或 EAS 构建；
4. 使用专用工具扫描完整 Git 历史；
5. 解包 APK，扫描 JavaScript bundle、资源和字符串；
6. 确认 APK 中不存在维护者的局域网 IP、私密云地址、API Key、Token 或私钥；
7. 生成 APK SHA-256，并与 APK 一起上传 GitHub Release；
8. 首次发布标记为 Pre-release。

如果任何真实凭据曾进入 Git 历史，不能只删除文件；必须先撤销并重新生成该凭据，再处理
仓库历史。

## 维护者发布资产

- `ReMind-Local-1.0.3-preview.1.apk`
- `SHA256SUMS.txt`
- 安装说明与已知限制
- 对应 Git tag，例如 `v1.0.3-local-preview.1`

发布前先创建 Draft Release，附件、校验值和说明全部确认后再转为公开 Pre-release。
