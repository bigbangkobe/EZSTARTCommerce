# EZSTARTCommerce

EZSTARTCommerce 是一个可配置、可复用、可独立部署的电商独立站模板项目。它面向需要快速上线自有品牌网店的商家。烟草是首个业务场景，商品类别和市场规则以配置/行业扩展方式提供，不写死在通用电商核心内。

## 文档导航
- [身份通知 Worker 与页面运行说明](apps/worker/README.md)：SMTP 配置、进程启动、租约重试、页面和验证边界。
- [完整上线实施记录](docs/IMPLEMENTATION_PROGRESS.md)：完整交付范围、模块实施顺序、本批改动及下一实施项。
- [R1 工程起步与运行说明](docs/R1_ENGINEERING_PROGRESS.md)：安装、检查、API 骨架及当前实现边界。
- [身份安全参数](docs/IDENTITY_SECURITY_POLICY.md)与[管理员恢复流程](docs/ADMIN_RECOVERY_RUNBOOK.md)
- [本轮契约审查与处理记录（2026-10-19）](docs/ANALYSIS_REVIEW_2026-10-19.md)：已修复问题、校验证据及剩余开发缺口。
- [接口契约校验命令](packages/contracts/README.md)
- [五项需求处理决议](docs/REQUIREMENT_RESOLUTION.md)
- [客户上线参数表](docs/CLIENT_LAUNCH_INPUTS.md)

- [完整产品总规格](docs/EZSTARTCOMMERCE_MASTER_SPEC.md)：产品范围、角色、前后台、业务规则、质量门槛、验收与里程碑统一基线。
- [开发执行规格](docs/DEVELOPMENT_SPEC.md)：冻结技术栈、默认规则、接口/数据约定、金额与状态机、权限、异常恢复和生产门槛，是跨模块工程实施契约。
- [API 接口契约](docs/API_SPEC.md)：首期路由、DTO 字段、权限、幂等、错误响应和交易规则；[OpenAPI 3.1 初稿](packages/contracts/openapi.yaml)用于生成客户端并作为接口校验基线。
- [测试策略与质量门禁](docs/TEST_STRATEGY.md)：单元/集成/API/浏览器 E2E/安全/性能/恢复测试分层、发布门禁及证据要求。
- [测试用例矩阵](docs/TEST_CASES.md)：编号的单元、API 功能、前后台 UI、全链路、安全和非功能测试场景。
- [产品与技术总体蓝图](docs/PRODUCT_TECHNICAL_BLUEPRINT.md)：产品、前后台、后端、API、数据、安全、部署和实施路线。
- [私有部署模式](docs/PRIVATE_DEPLOYMENT.md)：多商家独立实例、开通流程、隔离要求和运维选项。
- [客户前台定制方案](docs/CUSTOMIZATION_MODEL.md)：通用电商核心与客户独立前台的边界、定制流程和估算方式。
- [项目实施方案](docs/PROJECT_PLAN.md)：阶段、里程碑、团队、工作量、风险与验收门槛。
- [研发待办与发布切分](docs/PRODUCT_BACKLOG.md)：M00–M16 Epic、依赖关系、发布批次和进入开发的验收条件。
- [生产就绪验收清单](docs/PRODUCTION_READINESS_ACCEPTANCE.md)：售后、支付对账、履约库存、后台安全、隐私市场规则和运维恢复的端到端验收场景。
- [架构方案](docs/ARCHITECTURE.md)：模块边界、技术建议、外部集成和升级方式。
- [数据模型方案](docs/DATA_MODEL.md)：核心实体、关系、状态模型和治理要求。
- [模块方案索引](docs/modules/README.md)：所有功能模块的产品目标、范围、数据、验收和实施依赖。
- [逐页产品设计](docs/design/README.md)：设计系统、顾客前台页面、商家后台模块及核心业务流程。
- [待确认决策](docs/DECISIONS.md)：逐店经营参数、外部服务、合同边界和上线输入。

## 首期产品边界

- 商家品牌化的前台独立站与管理后台。
- 面向多个商家逐家独立私有部署；每家拥有独立后台和数据，并按业务单独设计/开发前台；本项目不建设 SaaS 多租户控制台。
- 顾客可始终访客结账；会员可自愿用一次性验证码登录会员中心，不设密码。
- 后台管理商品、订单、售后、完整会员规则、优惠券、库存、内容、支付/配送配置、通知及报表。
- 商家可在后台维护商品，并调整主题支持的首页/专题陈列区块和商品展示优先级，再预览发布到前台。
- 简体中文、繁体中文、英文。
- 支持货到付款，并以支付服务商适配器方式接入获批的线上支付方式。
- 提供商品 CSV/Excel 批量导入。
- 烟草行业能力按可配置的行业包处理；是否允许某个市场/商品上线，须经过业主的法规与服务商审核。

## 建议第一步

按 CLIENT_LAUNCH_INPUTS.md 完成首店参数表；评审需求处理决议、生产就绪验收清单、页面状态原型及客户专属前台页面/陈列清单，再冻结 PRODUCT_BACKLOG.md 和首店报价范围。

工程已建立 pnpm workspace 和 NestJS API 骨架。安装与运行见 [R1 说明](docs/R1_ENGINEERING_PROGRESS.md)，统一检查命令为 `pnpm check`。首店主初始化、MFA 和本人会话 API 已接入 PostgreSQL 18/Prisma 7；配置与范围见 [身份实现说明](docs/R1_IDENTITY_IMPLEMENTATION.md)。现已新增邀请后端、通知 Worker、接受邀请/登录/MFA/密码重设页面及员工/角色管理 API 与 /admin/access 页面，并按开发规格 7.1 预置 8 个默认岗位权限包（`packages/config/src/role-presets.ts`）；店铺设置（/admin/settings，含语言/币种/时区、功能开关与市场审核门禁）与审计记录读取界面（/admin/audit）已实现；商品目录、交易链路、完整后台和生产部署仍未完成。


