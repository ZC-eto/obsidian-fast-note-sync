# 安全多端同步客户端开发入口

## 文档状态

- 状态：第一阶段实现与本地验证完成；真实插件更新尚未执行
- 日期：2026-08-06
- 插件基线：`2.4.0`
- 当前 fork 自用构建版本：`2.4.1`
- 工作分支：`feat/safe-multi-device-sync`

## 权威规格

完整的跨仓库需求、协议语义、验收标准和实施顺序保存在配套服务端仓库：

```text
fast-note-sync-service/docs/safe-multi-device-sync.zh-CN.md
```

该文档是唯一权威规格。本文件只说明插件端入口，避免插件端与服务端各维护一份容易漂移的完整协议文档。

## 当前第一阶段交付边界

当前 feature 只交付安全修订同步：默认关闭的显式设置、capability/bootstrap、Resource/Vault Revision、operationId 幂等、修改/删除/重命名前置条件、本地 baseline/pending、远端删除保护与恢复原像。首次激活必须零 unresolved mismatch；本地关闭只暂停该设备，不解除服务端严格 Vault。

`MirrorPlan` / `MirrorApply`、本地发布端、远端镜像端、设备租约、权威覆盖、事务报告与整批回滚属于后续独立 feature，本阶段不实现也不在设置中暴露。

## 当前客户端行为

- 设置页提供默认关闭的 `safeRevisionSyncEnabled` toggle；只有用户确认开启后才进入 bootstrap。关闭时仅暂停本机，不能解除服务端 STRICT。
- 设置状态完整区分 `disabled`、`unsupported`、`activating`、`bootstrapping`、`active`、`strict-vault-local-disabled` 和 `error`。
- 服务端不是 PostgreSQL 用户库、SQLite 导入未验证或不支持安全协议时，toggle 保持关闭，不创建本地 active 状态。
- baseline、pending、稳定 deviceId 和空 Vault bootstrap 完成标记按 `serverFingerprint + uid + vaultId` 写入插件私有 JSON，并保留 localStorage 缓存；状态文件损坏时 fail-closed。
- bootstrap 只接受远端 live 下载后 hash 匹配或两端 hash 相同的资源。本地独有、hash 不同、远端墓碑但本地仍存在都记为 mismatch，不上传、不删除、不提交激活。
- pending 只有收到匹配 operationId 的 ACK 后才推进 baseline；超过 30 天保留窗口的 pending 标记为 expired，不再自动重发。
- 远端事件按连续 Vault Revision 串行领取和提交；分页中断、WebSocket 断开或应用尚未完成时不推进持久游标，重连后从最后确认 Revision 重拉。
- 远端删除先检查 pending、baseline 和当前 hash，再写入 `.obsidian/plugins/fast-note-sync/recovery/safe-sync/`；恢复区不可写时保留原文件并显示错误。
- 安全附件下载的分片、hash、大小和临时写盘任一步失败都会拒绝当前事件，不留下已推进的 baseline。

插件仍未写入真实 Obsidian 安装目录。发布时必须确认 `main.js`、`manifest.json`、`styles.css` 与 `package.json`/manifest 版本一致，并分别在桌面和 Android 上用复制 Vault 验证。

## 完整产品路线能力（含后续阶段）

- 持久化服务端资源修订、内容哈希和待确认操作
- 为修改、删除和重命名提交 `baseRevision`、`baseHash`、`deviceId` 和 `operationId`
- 收到远端删除前检查本地未提交修改和最后确认哈希
- 对删除、覆盖和远端镜像清理创建本地恢复原像
- 实现双向可写、本地发布端和远端镜像端状态机
- 实现本地覆盖远端、远端覆盖本地的差异预览与确认流程
- 展示镜像进度、事务报告、失败项目和恢复入口
- 支持协议能力协商，旧服务端不显示不可用的新功能
- 处理 Android 内存限制、后台中断和文件系统差异

## 首批重点模块

```text
src/lib/sync/
src/lib/storage/
src/lib/api/
src/pb/
src/setting.tsx
src/views/
tests/
```

## 实现与验证状态

实现前基线曾存在 `test:auth` 和 `test:mirror` 不可归因失败；当前分支已经建立统一 `pnpm test`，覆盖原有测试和安全同步 protobuf、状态存储、引擎、入站处理与传输测试。

- `pnpm test`：通过。
- `pnpm lint`：通过，0 error；`safe_sync_websocket_transport.ts` 仍有 4 条 `globalThis` warning。
- `pnpm build`：通过。
- 当前运行环境 Node `v22.20.0`，项目声明 `>=24.14.0`，因此 pnpm 命令仍显示 engine warning；发布构建应改用满足声明的 Node 版本复验。

真实桌面/Android 加载、复制 Vault smoke 和 Dokploy 服务切换尚未执行，不能据此文档声称已经发布完成。安装时必须核对 `manifest.json` 和 Obsidian 已加载版本均为 `2.4.1`。

## 禁止事项

- 不得只在客户端用 `mtime` 模拟修订冲突
- 不得把现有“完整同步”直接改成权威镜像
- 不得在扫描失败或哈希不完整时删除目标端文件
- 不得收到远端删除后直接删除存在本地未提交修改的文件
- 不得在唯一生产 Vault 上首次测试
