# 03 开发文档

工程实现契约：技术栈、接口、数据、状态机、金额、权限与异常恢复的冻结基线。

## 文档清单

| 文档 | 说明 |
|---|---|
| [DEVELOPMENT_SPEC.md](DEVELOPMENT_SPEC.md) | 开发执行规格：技术栈、默认规则、接口/数据约定、金额与状态机、权限、异常恢复、生产门槛（跨模块工程契约） |
| [API_SPEC.md](API_SPEC.md) | API 接口契约：路由、DTO、权限、幂等、错误响应、交易规则；OpenAPI 初稿见 `packages/contracts/openapi.yaml` |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构基线：模块边界、技术建议、外部集成、升级方式 |
| [DATA_MODEL.md](DATA_MODEL.md) | 数据模型方案：核心实体、关系、状态模型、治理要求 |
| [ADMIN_IDENTITY_LIFECYCLE.md](ADMIN_IDENTITY_LIFECYCLE.md) | 后台身份生命周期契约：初始化、邀请、MFA、会话 |
| [IDENTITY_SECURITY_POLICY.md](IDENTITY_SECURITY_POLICY.md) | 身份安全参数 identity-v1 |
| [R1_ENGINEERING_PROGRESS.md](R1_ENGINEERING_PROGRESS.md) | R1 工程起步与运行说明 |
| [R1_IDENTITY_IMPLEMENTATION.md](R1_IDENTITY_IMPLEMENTATION.md) | 数据库与管理员身份实现说明 |
| [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) | 完整上线实施记录 |
| [ANALYSIS_REVIEW_2026-10-19.md](ANALYSIS_REVIEW_2026-10-19.md) | 契约审查与处理记录 |

## 关联
- 设计逻辑：[06-产品设计逻辑](../06-产品设计逻辑/00-设计逻辑总览.md)（第 4 节横切规则）
- 测试：[04-测试文档](../04-测试文档/TEST_STRATEGY.md)
