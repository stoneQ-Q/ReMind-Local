# ReMind → Obsidian 同步设计

## 产品定位

ReMind 负责低摩擦采集、离线保存和 AI 整理；Obsidian 负责长期保管、
链接与深度编辑。原始随手记默认留在 ReMind 收件箱，只有用户手动选择
或未来由 AI 整理完成的笔记才进入 Obsidian。首版采用单向同步，避免两个
应用同时修改同一条笔记时发生静默覆盖。

```text
微信 / ReMind 快速记录
          ↓
   ReMind 本地 SQLite
          ↓
 标题、摘要、标签等整理
          ↓
 Obsidian Vault 中的 Markdown
```

## 推荐的 MVP：Android 直写 Vault

当前测试手机是 Android，因此优先使用系统目录选择器：

1. 用户在 ReMind 中选择一次 Obsidian Vault，或其中的 `ReMind` 文件夹。
2. Android 授予 ReMind 对该目录的持续读写权限。
3. 每条记录先可靠写入 ReMind 的 SQLite，不自动倾倒到 Vault。
4. 用户在笔记详情点击“保存到 Obsidian”后进入同步队列。
5. App 打开或从后台恢复时，只更新已选择的笔记。
6. 写入成功后记录内容 hash 和文件 URI；失败只进入重试队列，不影响记录。

Expo SDK 54 的 `expo-file-system` 已包含在 Expo Go 中，Android 可通过
Storage Access Framework 选择目录并写入文件，因此第一版可直接真机验证。

## iOS 策略

iOS 对外部目录的授权在 App 重启后可能失效，不适合承诺完全静默的持续
直写。首版提供两种方式：

- “保存到 Obsidian”按钮：通过 Obsidian URI 创建或覆盖指定笔记。
- 批量导出 Markdown：交给系统文件选择器保存到 Vault。

后续若要跨平台稳定自动同步，增加一个 Obsidian 社区插件或桌面同步器：
它从 ReMind 云端增量拉取，并在 Vault 内写文件。这样 iOS 端无需绕过
系统沙箱。

## 文件组织

```text
Vault/
└── ReMind/
    └── Inbox/
        └── 2026/
            └── 07/
                └── 2026-07-26-1237-短标题--<note-id>.md
```

每条记录一个文件；文件名包含短标题和稳定 ID，重命名标题时也能识别同一
条记录。首版不自动删除 Obsidian 文件。

## Markdown 格式

```markdown
---
remind_id: "018f..."
created: 2026-07-26T12:37:00+08:00
updated: 2026-07-26T12:38:10+08:00
source: wechat
status: inbox
tags:
  - remind/inbox
  - 旅行
---

# 整理旅行计划

下周要开始整理旅行计划。

## ReMind 摘要

准备下周启动旅行计划整理。
```

`remind_id` 是去重依据；`source` 可取 `app`、`wechat`、`share`。原始内容
必须保留，AI 只补充标题、摘要和标签。

链接来源笔记额外使用 `record_type: "source"`，正文会包含“我的保存意图”
和“原始证据”。证据是 Worker 已在抓取正文中逐字校验过的引用片段，末尾
保留可点击的原文链接，因此即使离开 ReMind 也能理解观点依据并回到来源。

持续生长的主题笔记使用 `record_type: "theme"`。每次用户确认主题 patch 后，
ReMind 只追加本次新增内容、潜在冲突和来源链接，再按同一个稳定
`remind_id` 更新 Obsidian 文件；拒绝建议不会改写主题笔记。

用户修改主题名称或正文后，下一次同步会按新的内容指纹更新同一导出记录。
来源重新归类时，新旧主题都会进入同步检查：新主题获得该来源贡献，旧主题移除
能够精确匹配的原贡献。若用户已手动改写到无法安全匹配，App 不做猜测性删除，
而是保留旧正文并提示人工检查。

SQLite v14 起，主题的“当前理解”独立存放在 `theme_overviews`。导出主题时，
它会作为标题后的 `## 当前理解` 写入同一个 Markdown 文件；用户编辑概览或
确认新的概览更新都会改变导出指纹，不创建第二个文件。

## ReMind 本地同步状态

新增一张独立表，不污染笔记正文：

```sql
CREATE TABLE obsidian_exports (
  note_id TEXT PRIMARY KEY NOT NULL,
  file_uri TEXT,
  exported_hash TEXT,
  exported_at TEXT,
  status TEXT NOT NULL,
  last_error TEXT,
  FOREIGN KEY (note_id) REFERENCES notes(id)
);
```

状态为 `pending`、`exported` 或 `failed`。正文或 AI 整理结果变化后，
内容 hash 改变，重新进入 `pending`。

## 冲突与安全边界

- MVP 只做 ReMind → Obsidian 单向同步。
- 写文件时先生成临时内容，再覆盖目标，避免半截文件。
- ReMind 删除笔记时不删除 Obsidian 文件，只在 frontmatter 标记归档。
- Obsidian 中的手动修改不会自动回写 ReMind。
- 所有 Markdown 都可独立阅读，用户停止使用 ReMind 后仍能保留数据。

## 当前实现状态

1. [x] 生成带稳定 ID、来源和状态的 Markdown。
2. [x] Android 选择 Vault 根目录，自动创建 `ReMind/Inbox`。
3. [x] 原始记录默认只留在 ReMind 收件箱。
4. [x] 笔记详情支持手动选择“保存到 Obsidian”。
5. [x] 已选择笔记在编辑、删除和 App 恢复前台时自动补同步。
6. [x] 显示“已同步 / 待同步 / 失败”并支持手动重试。
7. [x] 对早期批量导出的原始记录提供带确认的清理入口。
8. [ ] Android + Obsidian 精选同步真机验收。
9. [ ] iOS 接入 Obsidian URI 和批量 Markdown 导出。
10. [ ] 需要真正跨平台后台同步时，再做 Obsidian 插件。
