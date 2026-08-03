# ReMind Weixin Gateway

不依赖 OpenClaw 的微信 iLink 收件网关。它使用腾讯
`Tencent/openclaw-weixin` 公开的登录和消息协议，将指定微信用户发给
ClawBot 的内容写入 ReMind。

## 本地测试

```bash
npm install
npm run login
REMIND_API_URL=http://127.0.0.1:8787 npm run pair -- 123456
REMIND_API_URL=http://127.0.0.1:8787 npm start
```

登录凭据和 ReMind 连接器密钥保存在
`~/.remind-weixin/config.json`，文件权限为 `0600`。不要提交或分享该文件。

当前 MVP 支持文字、语音转写文本和文件名记录；只接受扫码账号本人发来的
私聊消息。后续云化时应将凭据加密存储，并为每个用户运行隔离的长轮询任务。
