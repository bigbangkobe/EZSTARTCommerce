# 05 部署运维文档

实例的部署、隔离、安全恢复与运维流程。

## 文档清单

| 文档 | 说明 |
|---|---|
| [LAUNCH_READINESS.md](LAUNCH_READINESS.md) | **上线准备度报告**：10 项阻断签字状态、已知风险与缓解、发布与回滚顺序、烟草客户复制清单 |
| [AWS_ENVIRONMENTS.md](AWS_ENVIRONMENTS.md) | **AWS 环境接入与运维手册**：实例清单（含 staging）、SSH 连接、目录与容器拓扑、当前状态快照、常用操作、对账定时任务、凭证管理、已知缺口、待建基础设施 |
| [PRIVATE_DEPLOYMENT.md](PRIVATE_DEPLOYMENT.md) | 私有部署模式：多商家独立实例、开通流程、隔离要求、运维选项 |
| [ADMIN_RECOVERY_RUNBOOK.md](ADMIN_RECOVERY_RUNBOOK.md) | 管理员密码轮换、MFA 强制恢复与因子遗失的处置流程（含实测命令） |
| [RELEASE_M05_IMPORT.md](RELEASE_M05_IMPORT.md) | 发布 M05 批量导入到生产的分布清单：备份 → 迁移 39 → 冒烟 → 店主验收 → 回滚 |
| [交付工具链规范（P4）](../01-产品文档/DELIVERY_TOOLCHAIN_SPEC.md) | 标准部署包 / 一键起实例 / 批量升级：命令、版本兼容与安全边界 |

## 关联
- 部署规格：[03-开发文档/DEVELOPMENT_SPEC.md](../03-开发文档/DEVELOPMENT_SPEC.md)
- 实例开通设计：[01-产品文档/modules/M15_SECURITY_DEPLOYMENT.md](../01-产品文档/modules/M15_SECURITY_DEPLOYMENT.md)
