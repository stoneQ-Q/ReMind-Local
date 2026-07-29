# ReMind 本地云端环境

这个目录用于在开发机上运行与云厂商无关的云端基础设施。当前只包含 PostgreSQL 和第一版多用户数据模型，不会连接或修改现有的 `remind.db`、D1 或微信配置。

## 前置条件

- Docker Desktop 或其他支持 Docker Compose 的兼容运行环境。
- Docker 引擎已经启动。

## 首次启动

1. 将 `.env.example` 复制为 `.env`。
2. 把示例密码替换为仅用于本机开发的随机长密码。
3. 在本目录执行 `docker compose up -d postgres`。
4. 执行 `docker compose ps`，确认 PostgreSQL 显示为 `healthy`。

首次创建数据卷时，`db/migrations` 中的 SQL 会自动执行。已有数据卷不会自动重放初始化脚本；后续迁移必须使用独立的迁移执行器。

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

