# ReMind Local 1.0.3 preview.1

这是第一个面向其他用户的 Android + macOS 本地自托管预览版。

## 这次包含

- 本地模式与当前 ReMind 的记录、图片记录、搜索、整理、主题、问答、回望和 Obsidian
  能力保持同一套应用代码；
- 修复此前确认的 P0 升级与数据保留问题；
- 图片记录从首页“+”直接选择图片，不再增加单独入口窗口；
- 重做图片记录入口图标，并将引导文案简化为“写下当时的感受”；
- App 内可以填写并检查自己的 Mac 本地服务地址，无需为每位用户单独打包地址；
- Mac 提供双击式设置入口，在本机浏览器中保存用户自己的 API Key 并启动后台服务；
- DeepSeek Key 必填，智谱 Key 可选；两者都不会写入 APK、GitHub 或 App；
- 使用独立应用标识 `app.remind.notes.local`，可与个人测试版并存安装。

## 安装

1. 下载并安装 `ReMind-Local-1.0.3-preview.1.apk`；
2. 在 Mac 下载本 Release 的源代码并解压；
3. 安装 Node.js 22 或更高版本；
4. 双击 `setup-local.command`，按浏览器页面提示配置自己的 Key；
5. 将设置完成后显示的地址填入 App 的“连接自己的 Mac”。

详细步骤见 `docs/PUBLIC_LOCAL_RELEASE.md`。

## 已知限制

- 当前只支持 Android 手机和 macOS 本地服务；
- 手机与 Mac 需要在同一局域网，Mac 休眠时 AI、链接处理和微信同步会暂停；
- 微信首次登录与配对仍需要额外扫码步骤；
- 这是预览版，不建议把它作为唯一的数据副本；请继续保留 Obsidian 或其他备份。

## 文件校验

下载后请用 Release 中的 `SHA256SUMS.txt` 核对 APK。校验值会在构建完成后写入。
