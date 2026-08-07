# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 报告语言

CodeStable 所有落盘产出的正文使用简体中文。机器状态字段、代码标识符、命令和日志保持原始语言。

## 项目碎片知识

### 编译与构建

- 插件使用 TypeScript，最小构建命令为 `pnpm build`，静态检查为 `pnpm lint`。

### 测试

- 当前独立测试入口为 `pnpm test:auth`、`pnpm test:mirror` 和 `pnpm test:vault-name`。

### 路径与目录约定

- 客户端入口文档为 `docs/safe-multi-device-sync-client.zh-CN.md`。
- 跨仓库权威规格位于服务端仓库 `docs/safe-multi-device-sync.zh-CN.md`。
- 协议、用户设置和破坏性同步语义必须与服务端仓库协同修改。

### 环境变量与凭证

- 不把服务端令牌、Vault 私有内容或发布凭证写入仓库和测试日志。

### 其他

- 新安全同步能力必须由用户在设置中显式启用，默认保持现有兼容行为。
- 删除、镜像和回滚不得首次在唯一生产 Vault 验证。
