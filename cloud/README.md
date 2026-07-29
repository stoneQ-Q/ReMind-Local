# ReMind 本地云端环境

这个目录用于在开发机上运行与云厂商无关的云端基础设施。当前包含 PostgreSQL、第一版多用户数据模型、最小 API 和异步 Worker，不会连接或修改现有的 `remind.db`、D1 或微信配置。

## 前置条件

- Docker Desktop 或其他支持 Docker Compose 的兼容运行环境。
- Docker 引擎已经启动。

## 首次启动

1. 将 `.env.example` 复制为 `.env`。
2. 把示例密码替换为仅用于本机开发的随机长密码。
3. 在本目录执行 `docker compose up -d --build`。
4. 执行 `docker compose ps`，确认 PostgreSQL 和 API 显示为 `healthy`，Worker 显示为运行中。

`migrate` 服务会在 API 和 Worker 启动前按文件名顺序执行 `db/migrations`，并保存文件校验值。已经执行的迁移如果被修改，启动会直接失败，避免不同环境出现无法发现的 schema 差异。

## 本地端口

- PostgreSQL：`127.0.0.1:5432`
- 云端 API：`127.0.0.1:8790`
- API 进程健康检查：`GET /health`
- API 与数据库联合就绪检查：`GET /ready`

这些端口只绑定本机，不会直接暴露给同一局域网中的其他设备。未来 App 联调时通过单独的开发入口提供访问。

## Worker 骨架

当前 Worker 只领取类型为 `system.noop` 的零费用测试任务。任务领取使用 PostgreSQL 的 `FOR UPDATE SKIP LOCKED`：

- 多个 Worker 不会同时领取同一任务；
- 完成任务时同时校验任务 ID、用户 ID 和运行状态；
- 未实现的真实任务不会被误领取；
- 当前不会发起模型调用或产生第三方费用。

## 匿名账号

当前云端 API 提供：

- `POST /api/v1/auth/register`：创建匿名账号、首台设备、30 天会话和恢复码；
- `POST /api/v1/auth/recover`：使用恢复码为原账号增加一台设备；
- `POST /api/v1/auth/refresh`：使用长期设备密钥换发新的 30 天会话；
- `GET /api/v1/users/me`：验证会话并读取当前账号；
- `GET /api/v1/devices`：只读取当前账号自己的设备。

恢复码、设备密钥和会话令牌只在创建时返回原始值。数据库分别保存 SHA-256 哈希，不保存可还原的原始值。恢复码支持忽略大小写、空格和连字符，但必须妥善保管；服务端无法替用户找回原始恢复码。

App 在会话剩余 7 天或更少时使用设备密钥自动续期。续期成功后，原会话令牌立即失效，新的会话继续有效 30 天。正常使用不会要求用户定期输入恢复码；只有设备密钥丢失、设备被撤销或更换手机时才需要恢复码。

## AI 模式与用户 API Key

每个账号默认使用 `disabled`，可以切换为：

- `disabled`：关闭 AI，不读取任何模型凭据；
- `bring_your_own_key`：使用用户自己配置的 DeepSeek 或智谱 Key；
- `managed`：使用 ReMind 托管额度；当前只保存模式，计费完成前不会发起真实调用。

云端 API 提供：

- `GET /api/v1/ai/settings`：读取模式和已配置供应商；
- `PUT /api/v1/ai/settings`：切换 AI 模式；
- `PUT /api/v1/ai/credentials/:provider`：新增或替换用户 Key；
- `DELETE /api/v1/ai/credentials/:provider`：物理删除用户 Key。

API 永远不返回完整 Key，只返回供应商、末四位和更新时间。Key 使用 AES-256-GCM 加密，每次加密使用独立随机 nonce，并将用户 ID、供应商和密钥版本绑定为附加认证数据；密文被复制给另一用户或供应商后无法解密。

本地开发使用 `.env` 中的 32 字节主密钥。轮换时：

1. 将旧版本与旧密钥加入 `REMIND_CREDENTIAL_KEY_RING_JSON`；
2. 把新的版本和密钥设置为当前活动密钥；
3. 执行 `docker compose run --rm api node dist/rotate-credentials.js`；
4. 验证所有凭据都已更新后，再从 key ring 中移除旧密钥。

正式收费前必须把本地主密钥适配器替换为云 KMS，不能把生产主密钥长期保存在普通环境变量中。

## 备份

`backup` 服务启动后会立即生成一份 PostgreSQL 自定义格式备份，之后默认每 24 小时备份一次，并保留最近 7 天。备份文件位于本机 `cloud/backups`，已排除在 Git 之外。

执行 `./scripts/verify-backup-restore.sh` 可以：

1. 生成一份手动备份；
2. 创建临时数据库；
3. 完整恢复；
4. 对比表数量和迁移数量；
5. 自动删除临时数据库。

备份文件包含用户私有数据和凭据密文，不能上传到公开仓库。部署到云端后，备份还必须进行独立加密并复制到异地存储。

## 停止与清理

- 停止但保留数据：`docker compose stop`
- 再次启动：`docker compose start`

不要执行 `docker compose down -v`，它会删除本地 PostgreSQL 数据卷。需要重建测试数据库时，也必须先确认其中没有需要保留的数据。

## 当前数据边界

- 云端所有私有实体都包含 `user_id`。
- 设备密钥和会话令牌只保存哈希。
- 微信凭据和用户 API Key 只预留密文字段。
- 文件只保存对象存储引用，不把二进制内容塞入数据库。
- 账本只允许追加，数据库触发器拒绝修改和删除历史记录。
- 任务使用每用户幂等键，避免重试造成重复执行或重复扣费。
