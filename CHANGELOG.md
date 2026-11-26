# Changelog

本文件记录项目的重要版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。

## [v1.0.0] - 2026-11-27

首个正式生产发布版本。In先生（mrinhk.com）商城系统全链路测试完成并交付上线。

### 修复（Fixed）

- **BUG-01（P2）** 商品 CSV 导入上传恒 403：`media/storage.ts` 的 `authorize()` 放行导入对象键（`isImportObjectKey`），导入功能端到端恢复可用（commit `75bf287`）。
- **BUG-02（P1）** 取消导入任务恒 500：cancel 不再写 `completedAt`（违反 `ImportJob_completed_check` 约束），改为只更新状态（commit `4fbd4f7`）。

### 安全（Security）

- Owner 默认凭据轮换：旧密码失效、历史会话全部吊销、新默认密码 + 首登强制改密（交付模式，密码不落文档/日志）。
- 生产 BUG-01 修复已复测生效（Owner 登录 → import-files 201 → 签名 PUT 204）。

### 测试与文档（Docs & Test）

- 全量测试：201 条 API 路由路径级比对零差异；119+ 用例全部线上实测，无阻断项；实测发现并修复 2 个真实缺陷。
- 测试报告标记同步：回填 90 处历史 🔒 → ✅，新增第 14 节覆盖度审计，修正过期结论。
- 新增客户交付文档 `HANDOVER_DELIVERY.md`、隔离测试环境文档 `STAGING_ISOLATED_TESTING.md`。
- 备份能力验证：`ezstart-backup.timer` 每日自动备份，恢复到临时库验证数据一致（Product 268/268、MediaAsset 543/543）。当前缺异机副本（需 EC2 绑定 S3 IAM 角色后启用 `BACKUP_BUCKET`）。

### 待办（Known Limitations）

- 异机备份：需为 EC2 绑定含 S3 写权限的 IAM Instance Profile 并配置 `BACKUP_BUCKET`（脚本已支持，配置即生效）。
- 12 项 P3 契约/加固级观察点（详见测试报告第 8/13 节），非阻断。
- 6 项因测试条件缺失未做正向实测的接口（MFA enroll 正向、store-config 写、退款 reject、埋点 events），详见测试报告第 3 节。

[v1.0.0]: https://github.com/bigbangkobe/EZSTARTCommerce/releases/tag/v1.0.0
