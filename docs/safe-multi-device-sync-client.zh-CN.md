# 安全多端同步客户端开发入口

## 文档状态

- 状态：Windows 当前为 `2.5.14`；`2.5.15` 正在修复权威覆盖后迟到的旧同步消息被误判为缺少安全事件的问题，Android 暂不更新
- 日期：2026-08-12
- Windows 当前版本：`2.5.14`
- 当前 fork 自用构建版本：`2.5.15`
- 工作分支：`feat/safe-multi-device-sync`

## 权威规格

完整的跨仓库需求、协议语义、验收标准和实施顺序保存在配套服务端仓库：

```text
fast-note-sync-service/docs/safe-multi-device-sync.zh-CN.md
```

该文档是唯一权威规格。本文件只说明插件端入口，避免插件端与服务端各维护一份容易漂移的完整协议文档。

## 当前交付边界

当前 feature 交付安全修订同步、三种设备角色、“本地覆盖远端”、“远端覆盖本地”、差异预览、高风险确认、目标端恢复包、最近一次回滚与最终哈希校验。安全多端同步仍需用户在设置中显式开启；首次普通激活要求本地与远端零差异，有差异时可先使用权威覆盖完成对齐。

权威覆盖首版只处理 Markdown 笔记、普通附件、文件夹和空目录，不处理 Obsidian 配置目录。差异计划 30 分钟过期，恢复包保留 30 天；删除或类型替换达到 50 项或目标清单 10% 时，必须输入“确认覆盖”才能执行。

## 当前客户端行为

- 设置页提供默认关闭的 `safeRevisionSyncEnabled` toggle；只有用户确认开启后才进入 bootstrap。关闭时仅暂停本机，不能解除服务端 STRICT。
- “安全多端同步”右侧的问号会解释修订保护、三种角色、两个覆盖方向、恢复包与 Obsidian 配置目录边界。
- 双向端可上传和下载；本地发布端持有 2 分钟租约时阻止其他设备安全写入；远端镜像端只下载。
- 设备角色管理旧“只读同步”设置；远端镜像端同时锁定并关闭“离线删除上传”，避免与旧开关互相矛盾。
- 权威覆盖与旧“完整同步”、“按时间合并”互不复用；每次都先扫描并显示新建、更新、删除和类型替换。
- Vault 根目录 `/` 不参与清单比较；Markdown 的大小统一按 Obsidian 实际读取内容的 UTF-8 字节数计算，避免 Windows CRLF 规范化后产生虚假差异或写入失败。
- 权威覆盖附件不受日常大附件自动跳过阈值影响；等待完成模式下的缺文件、断线、取消和提交失败都会中止事务并清理对应的本地待提交记录，不能被误报为已完成。
- 从权威预览开始扫描起，到用户取消或覆盖完成为止，普通增量上传、下载及远端事件应用统一暂停；维护操作完成或失败后自动恢复，避免后台同步在耗时清单扫描期间抢先写入同一路径。若普通同步已经开始，则要求等待其完成后再生成预览。插件会先在维护锁下完成本地清单扫描，再建立远端冻结快照，使服务端 30 分钟有效期完整留给差异确认、恢复包和提交。
- 权威基准成功提交后，插件会在第一条权威写入前清除差异计划所覆盖路径上的本机旧 pending。该清理只作用于已由用户确认交给权威源覆盖的路径，避免历史附件上传记录阻塞同一计划的 CREATE / UPDATE，同时不影响计划外 pending。
- 权威覆盖完成后，旧分页通道可能迟到下发同一路径的 NOTE / FILE / FOLDER `UPSERT`。插件 `2.5.15` 只有在 payload、本地真实内容和已确认 baseline 的类型、路径、哈希完全一致，baseline 已由当前持久 Vault Revision 确认，并且该路径没有 pending 或待应用安全事件时才把它作为重复消息归账；内容缺失、类型不符、哈希不同或仍有安全事件时继续 fail-closed。
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
- 启动同步先拉取连续事件并按 operationId 确认“服务端已提交但客户端 ACK 未落盘”的 pending；服务端尚未提交的笔记、目录和附件操作使用原 operationId 幂等重放。网络超时或断线不再删除结果不确定的 pending。
- 新 pending 持久化资源类型，旧状态仍可通过 baseline、远端事件和本地清单兼容恢复；目录 pending 会阻止同目录树内重叠写入。附件恢复前必须重新校验本地 hash 与 size，内容已经变化时 fail-closed，不会上传错误快照。
- 远端事件按连续 Vault Revision 串行领取和提交；分页中断、WebSocket 断开或应用尚未完成时不推进持久游标，重连后从最后确认 Revision 重拉。
- 安全模式启动时先拉取并校验远端 Vault Revision，再用持久化 baseline 对账离线期间的本地新增、修改、删除和可唯一确认的重命名；本地与远端同时偏离同一 baseline 时进入 `error` 并暂停，不按 `mtime` 猜测覆盖方向。
- 启动对账确认的 Markdown 修改通过 `SafeNoteMutation` 提交，附件新增或修改通过 `SafeFileUploadStart`、安全分片和 `SafeFileUploadCommit` 提交；随后旧清单通道只负责触发远端内容下发。安全模式收到不带内部提交回调的旧 `NoteSyncNeedPush` / `FileUpload` 时直接归账并忽略，不进入上传队列，也不发送旧二进制分片。
- 同步进行中收到新的 `SafeSyncEvent` 不再丢弃；客户端会合并通知，并在当前同步或权威覆盖结束后重新拉取连续修订。显式排除路径和云预览托管但本地不存在的附件不会被启动对账解释为删除。
- 插件 `2.5.11` 在安全修订队列直接执行 DELETE / RENAME 后，会把旧清单通道随后下发的同一删除或重命名仅作为分页归账并忽略，避免二次认领已提交事件后进入 `no matching safe sync event` 错误。处于 paused/error 状态时同样不会回退执行旧协议写入。
- 安全协议消息使用自己的请求 context，不受旧批量同步 `activeSyncContext` 过滤；`SafeSyncEventsAck`、安全 mutation ACK 和其他 `Safe*` 控制消息可在旧清单同步期间正常返回，普通同步消息仍必须匹配活动 context。
- 远端删除先检查 pending、baseline 和当前 hash，再写入 Obsidian 配置目录下的 `plugins/fast-note-sync/recovery/safe-sync/`；恢复区不可写时保留原文件并显示错误。
- 安全附件下载的分片、hash、大小和临时写盘任一步失败都会拒绝当前事件，不留下已推进的 baseline。

Windows 插件 `2.5.11` 已写入真实 Obsidian 安装目录并完成热重载；设置页、问号帮助、三种设备角色、两个覆盖按钮和最近一次回滚入口均保留。两个权威覆盖方向及对应回滚使用隔离的内存 Vault 与远端状态执行；Android 保持 `2.5.8`，本轮不更新。

## Windows 与 Android 自用安装记录

- Vault：`E:\Document\Notes`
- 插件目录：`E:\Document\Notes\.obsidian\plugins\fast-note-sync`
- Windows 安装版本：GitHub Release `2.5.11`，分支提交为 `7686c33fd13d`，`main.js` SHA-256 为 `a7d15ce8c67a3ad8568e1e8bb443ec2e738d59835620fca5d7ddab02ceb83bff`；安装前程序、设置、根目录哈希状态和 safe-sync 状态备份位于 `E:\Document\Notes\.obsidian\plugin-backups\fast-note-sync\2.5.10-before-2.5.11-20260812-010647`
- GitHub 当前 Release 为 `2.5.11`；Android 安装版本仍为 `2.5.8`。
- Android 手工安装包：`E:\Tools\Obsidian\android-plugin\fast-note-sync-v2.5.8.zip`；SHA-256 为 `2779a335d00287b15b5c57a8822694c458d4f94b8fe535285942fcb04728e483`，包内 `manifest.json` 已确认版本为 `2.5.8`、`isDesktopOnly=false`、作者为 `ZC-eto`。程序文件已安装到 Xiaomi 15 的 `内部存储设备\Sync\Notes\.obsidian\plugins\fast-note-sync`，手机读回版本和三个程序文件哈希均通过；原设置与同步状态文件保留，电脑端安装前备份为 `E:\Tools\Obsidian\android-plugin\backups\Xiaomi15-fast-note-sync-before-2.5.8-20260809-213152`
- 最近回滚目录：域名切换前备份为 `E:\Document\Notes\.obsidian\plugin-backups\fast-note-sync\before-domain-fns-902830-20260809-215003`；版本升级前备份为 `2.5.7-before-2.5.8-20260808-165400`，前一份为 `2.5.6-before-2.5.7-20260808-163700`
- 服务地址：`https://fns-902830.prismio.net`；Android 域名切换时手机未连接，手机端 `data.json` 尚待写入该地址
- 认证：沿用迁移前的现有授权令牌；`data.json` 仅保存 `fns-enc2:` 混淆值，不记录明文
- 持久状态：`fileHashMap-v2.json`、`folderSnapshot.json`、`syncHashMap.json` 均保留；v1 文件哈希缓存不再迁移，升级后会按修复后的 Range 读取规则重建
- `safe-sync/` 的设备状态和 `recovery/` 的权威覆盖恢复包属于设备私有数据，即使启用旧“配置同步”也会被硬排除，不上传到远端或其他设备
- 运行验证：Obsidian 已加载 `2.5.11`，WebSocket 已连接并鉴权；安全同步已开启，角色为 `bidirectional`，运行状态为 `active / STRICT`，capability 为 `true`，写入模式为 `safe`。
- 正文一致性：`英语/练习/2026-08-11.md` 使用 Windows 原正文安全重提后，Vault Revision 从 `174` 推进到 `175`；`/api/note` 与本地正文逐字节一致，两端均为 `24449` 字节，pending 为 0。
- Windows 自动同步 smoke：通过 Obsidian 正常创建、修改、删除唯一临时 Markdown，未直接调用安全 mutation；Vault Revision 依次推进到 `176 / 177 / 178`，每一步 VPS 均确认。本地临时文件已清理，状态保持 `active / STRICT / safe`，控制台无错误。
- 权威预览：生产 Vault 本地与远端均为 875 项，CREATE / UPDATE / DELETE / REPLACE 全部为 0；等待取消完成后状态恢复为 `active / STRICT / safe`
- 中断恢复：实机人为清除本地 bootstrap session 后，客户端使用稳定 device ID 接管本机原 session 并成功取消；没有残留 preview、bootstrap 或 busy 状态，控制台无 error/warning
- 文件核对：Windows 实际安装的 `main.js` SHA-256 与 GitHub `2.5.11` Release digest 一致；原 `data.json`、hash map、folder snapshot、safe-sync 状态和恢复包均保留。

域名切换时再次确认 LocalStorage 中的 API 地址优先于 `data.json`。因此不能只编辑配置文件；本次先把 893 条 baseline、0 条 pending 从旧域名指纹 `81a3bf7e-u1-v1` 复制迁移到新指纹 `b2af6334-u1-v1`，再通过插件正式 `saveAndReloadServices("api")` 路径同时更新运行配置、LocalStorage 和 `data.json`，重连后确认实际使用 `https://fns-902830.prismio.net`。

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
- 2026-08-12 的 `2.5.11` 修复新增 `safe-sync-reconciler`、`safe-sync-runtime-startup` 测试，并在 `test:auth` 中补充安全 ACK 绕过旧同步 context 的回归断言；本机全量 `pnpm test`、`pnpm lint`、`pnpm lint:css` 与 `pnpm build` 均通过。本机使用 Node `v22.20.0` 会产生 engine warning；GitHub Release 工作流已使用声明的 Node `v24.14.0` 与 pnpm `11.1.2` 重跑相同闸门并成功发布。

Windows 实机加载、设置交互、Dokploy `3.6.11` 服务连接、正式域名、生产正文一致性和本地自动创建/修改/删除已经验证，`manifest.json` 与 Obsidian 实际加载版本均为 `2.5.11`。`SafeMirrorManager` 隔离集成测试仍覆盖本地覆盖远端、远端覆盖本地、两个方向回滚、预览后本地漂移失效、计划过期失效及远端镜像端禁止覆盖远端。Android `2.5.8` 本轮未更新，真实双设备传播仍待后续验收。

## 禁止事项

- 不得只在客户端用 `mtime` 模拟修订冲突
- 不得把现有“完整同步”直接改成权威镜像
- 不得在扫描失败或哈希不完整时删除目标端文件
- 不得收到远端删除后直接删除存在本地未提交修改的文件
- 不得在唯一生产 Vault 上首次测试
