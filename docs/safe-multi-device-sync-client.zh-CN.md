# 安全多端同步客户端开发入口

## 文档状态

- 状态：当前 Windows 自用范围已实现并发布；两个权威覆盖方向与回滚已通过隔离集成测试，Android 安装按用户要求后续单独进行
- 日期：2026-08-08
- 插件交付版本：`2.5.8`
- 当前 fork 自用构建版本：`2.5.8`
- 工作分支：`feat/safe-multi-device-sync`

## 权威规格

完整的跨仓库需求、协议语义、验收标准和实施顺序保存在配套服务端仓库：

```text
fast-note-sync-service/docs/safe-multi-device-sync.zh-CN.md
```

该文档是唯一权威规格。本文件只说明插件端入口，避免插件端与服务端各维护一份容易漂移的完整协议文档。

## 当前交付边界

当前 feature 交付安全修订同步、三种设备角色、“本地覆盖远端”、“远端覆盖本地”、差异预览、高风险确认、目标端恢复包、最近一次回滚与最终哈希校验。安全多端同步仍需用户在设置中显式开启；首次普通激活要求本地与远端零差异，有差异时可先使用权威覆盖完成对齐。

权威覆盖首版只处理 Markdown 笔记、普通附件、文件夹和空目录，不处理 Obsidian 配置目录。差异计划 10 分钟过期，恢复包保留 30 天；删除或类型替换达到 50 项或目标清单 10% 时，必须输入“确认覆盖”才能执行。

## 当前客户端行为

- 设置页提供默认关闭的 `safeRevisionSyncEnabled` toggle；只有用户确认开启后才进入 bootstrap。关闭时仅暂停本机，不能解除服务端 STRICT。
- “安全多端同步”右侧的问号会解释修订保护、三种角色、两个覆盖方向、恢复包与 Obsidian 配置目录边界。
- 双向端可上传和下载；本地发布端持有 2 分钟租约时阻止其他设备安全写入；远端镜像端只下载。
- 设备角色管理旧“只读同步”设置；远端镜像端同时锁定并关闭“离线删除上传”，避免与旧开关互相矛盾。
- 权威覆盖与旧“完整同步”、“按时间合并”互不复用；每次都先扫描并显示新建、更新、删除和类型替换。
- Vault 根目录 `/` 不参与清单比较；Markdown 的大小统一按 Obsidian 实际读取内容的 UTF-8 字节数计算，避免 Windows CRLF 规范化后产生虚假差异或写入失败。
- 权威覆盖附件不受日常大附件自动跳过阈值影响；等待完成模式下的缺文件、断线、取消和提交失败都会中止事务并清理对应的本地待提交记录，不能被误报为已完成。
- 权威覆盖和整批回滚期间，普通增量上传、下载及远端事件应用统一暂停；维护操作完成或失败后自动恢复，避免后台同步与权威操作同时修改同一路径。
- 点击执行后会重新校验本地清单；预览后本地或远端发生变化时计划失效，必须重新生成差异。服务端会在普通同步切换到安全基准前按当前实际记录刷新清单，避免把迁移时的旧哈希误判为远端中途变化。
- 预览读取本地清单失败，或覆盖在提交安全基准前失败时，会立即取消 bootstrap 并清空活动预览；取消响应失败时保留 session 供重试，插件重启或调用中断导致本地 session 丢失时，会先用稳定设备 ID 安全接管本机原 session 再取消，不能取消其他设备的活动 session，也不会静默卡在错误的建立基准状态。若已提交为 `STRICT` 后执行失败，则保留恢复包供用户回滚。
- 覆盖过程异常退出后，状态为 `APPLYING` 的最近恢复包仍可回滚；嵌套目录先处理子项再处理父目录。
- 回滚开始前会校验恢复包中每个正文和附件的字节数及哈希，任一原像损坏都会在修改目标端之前中止。
- 恢复包尚未完整生成、覆盖尚未开始时发生的失败会记录为 `ABORTED`，不会覆盖上一份有效回滚入口；旧版本遗留的错误指针会从保留记录中自动修复。只有已进入覆盖阶段的 `FAILED` 记录可以回滚。
- 设置状态完整区分 `disabled`、`unsupported`、`activating`、`bootstrapping`、`active`、`strict-vault-local-disabled` 和 `error`。
- 服务端不是 PostgreSQL 用户库、SQLite 导入未验证或不支持安全协议时，toggle 保持关闭，不创建本地 active 状态。
- baseline、pending、稳定 deviceId 和空 Vault bootstrap 完成标记按 `serverFingerprint + uid + vaultId` 写入插件私有 JSON，并保留 localStorage 缓存；状态文件损坏时 fail-closed。
- bootstrap 只接受远端 live 下载后 hash 匹配或两端 hash 相同的资源。本地独有、hash 不同、远端墓碑但本地仍存在都记为 mismatch，不上传、不删除、不提交激活。
- pending 只有收到匹配 operationId 的 ACK 后才推进 baseline；超过 30 天保留窗口的 pending 标记为 expired，不再自动重发。
- 远端事件按连续 Vault Revision 串行领取和提交；分页中断、WebSocket 断开或应用尚未完成时不推进持久游标，重连后从最后确认 Revision 重拉。
- 远端删除先检查 pending、baseline 和当前 hash，再写入 Obsidian 配置目录下的 `plugins/fast-note-sync/recovery/safe-sync/`；恢复区不可写时保留原文件并显示错误。
- 安全附件下载的分片、hash、大小和临时写盘任一步失败都会拒绝当前事件，不留下已推进的 baseline。

Windows 插件 `2.5.0` 已写入真实 Obsidian 安装目录并完成普通同步 smoke；设置页、问号帮助、三种设备角色、两个覆盖按钮和最近一次回滚入口已在真实 Obsidian `1.13.4` 中验收。两个权威覆盖方向及对应回滚使用隔离的内存 Vault 与远端状态执行，不在唯一生产 Vault 首次执行破坏性覆盖。Android 本轮不安装，发布 ZIP 保持 `isDesktopOnly=false` 且不使用桌面专属 API，供后续手工导入。

## Windows 自用安装记录

- Vault：`E:\Document\Notes`
- 插件目录：`E:\Document\Notes\.obsidian\plugins\fast-note-sync`
- 安装版本：`2.5.0`，Release tag 提交 `ab673c7`；分支后续 CI 修复提交为 `2f2b858`
- 回滚目录：`E:\Document\Notes\.obsidian\plugin-backups\fast-note-sync\2.4.0-before-safe-sync-20260807-091747`
- 服务地址：`https://fast-note-sync-safe-1irxvu-6387b0-23-144-4-140.sslip.io`
- 认证：沿用迁移前的现有授权令牌；`data.json` 仅保存 `fns-enc2:` 混淆值，不记录明文
- 持久状态：`fileHashMap-v2.json`、`folderSnapshot.json`、`syncHashMap.json` 均保留；v1 文件哈希缓存不再迁移，升级后会按修复后的 Range 读取规则重建
- `safe-sync/` 的设备状态和 `recovery/` 的权威覆盖恢复包属于设备私有数据，即使启用旧“配置同步”也会被硬排除，不上传到远端或其他设备
- 运行验证：Obsidian 已加载 `2.5.0`，WebSocket 已连接并鉴权，普通增量同步完成；设置页可见“安全多端同步”、问号帮助、设备角色、两个覆盖方向和回滚入口
- 服务能力：客户端观察到 capability 可用，服务端状态为 `OFF`；`safeRevisionSyncEnabled=false`，没有进入 bootstrap
- 文件核对：Windows 实际安装的 `main.js` SHA-256 为 `5b9c4f506dd01e5e653c630d8a013f8e175f74a40b3072ca3d12c1125d3c77ef`，与 GitHub `2.5.0` Release 资产一致；原 `data.json`、hash map 和 folder snapshot 均保留

启动时曾发现 LocalStorage 中的旧 API 地址优先于已更新的 `data.json`。本次已通过插件的正式 `saveAndReloadServices("api")` 路径同时更新运行配置、LocalStorage 和 `data.json`，重连后确认实际使用新临时域名。

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

实现前基线曾存在 `test:auth` 和 `test:mirror` 不可归因失败；当前分支已经建立统一 `pnpm test`，覆盖原有测试和安全同步 protobuf、状态存储、引擎、入站处理、传输、权威覆盖计划及 `SafeMirrorManager` 隔离集成测试。

- `pnpm test`：通过。
- `pnpm lint`：通过，0 warning、0 error；`pnpm lint:css`：通过。
- `pnpm build`：通过。
- 当前复验环境为 Node `v24.14.0`、pnpm `11.1.2`，满足项目声明的运行版本。

Windows 实机加载、普通增量同步、设置交互和 Dokploy 新服务连接已经验证，`manifest.json` 与 Obsidian 实际加载版本均为 `2.5.0`。`SafeMirrorManager` 隔离集成测试实际执行了本地覆盖远端、远端覆盖本地、两个方向回滚、预览后本地漂移失效、计划过期失效及远端镜像端禁止覆盖远端。Android、真实双设备传播和生产 Vault 首次安全同步 bootstrap 尚未执行；其中 Android 安装是用户明确延后的交付项，不属于当前 Windows 版本缺失功能。

## 禁止事项

- 不得只在客户端用 `mtime` 模拟修订冲突
- 不得把现有“完整同步”直接改成权威镜像
- 不得在扫描失败或哈希不完整时删除目标端文件
- 不得收到远端删除后直接删除存在本地未提交修改的文件
- 不得在唯一生产 Vault 上首次测试
