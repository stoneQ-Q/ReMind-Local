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

首次创建数据卷时，`db/migrations` 中的 SQL 会自动执行。已有数据卷不会自动重放初始化脚本；后续迁移必须使用独立的迁移执行器。

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
