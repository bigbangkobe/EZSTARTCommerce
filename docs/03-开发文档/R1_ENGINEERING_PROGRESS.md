# R1 工程起步与运行说明

日期：2026-10-19。当前已进入数据库与身份 API 实现阶段；首店主到会话撤销已通过真实数据库验证，R1 整体仍未完成。最新实现与配置见 [身份实现说明](R1_IDENTITY_IMPLEMENTATION.md)。

## 已有代码

- pnpm workspace、精确依赖锁文件、Node.js 24、应用 TypeScript 6、NestJS 12 API 骨架。
- OpenAPI 全量 TypeScript 类型生成、漂移检查、按 HTTP 状态及 nextAction 收窄的登录客户端及编译/调用测试。
- 身份安全默认参数、随机邀请凭据/摘要、邀请接受/重发/撤销规则、挑战/会话守卫及市场交易资格规则。
- PostgreSQL 18/Prisma 7 模型与迁移、Argon2id/TOTP/恢复码、持久限流、事务锁、审计和本人会话控制器。
- 真实 HTTP 存活/就绪检查、请求 ID、安全错误响应及 no-store；数据库未配置返回 503，配置且迁移校验通过才 ready。
- OpenAPI 结构与契约回归、领域规则单元测试、HTTP 集成测试及 GitHub Actions 工作流文件。

生成器 7.13.0 的 peer 要求 TypeScript 5；它与 TypeScript 5.9.3 隔离在 contracts 包内，应用编译仍用 TypeScript 6.0.3。pnpm 使用 hoisted 布局，以便根目录 dist 中的开发产物解析各 workspace 的运行依赖。dist 目前依赖工作区 node_modules，不是可独立交付的部署包。

NestJS 12 的 ESM/TypeScript 选型核对了 [官方迁移说明](https://docs.nestjs.com/migration-guide)；生成器支持范围以安装包的 peerDependencies 和 pnpm-lock 为准。CI action 版本参考 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[setup-python](https://github.com/actions/setup-python) 与 [pnpm/action-setup](https://github.com/pnpm/action-setup) 的官方说明。

## 安装与校验

需要 Node.js 24.15+（24 系列）、pnpm 8.15.9、Python 3.11。项目根目录运行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
python -m pip install --target .local-tools/contract-validation -r packages/contracts/requirements-validation.txt
pnpm check
```

`pnpm check` 自动使用项目本地 Python 校验依赖；若未安装本地目录则使用当前 Python 环境。CI 安装 Python 依赖后运行相同检查。契约修改后先运行 `pnpm contracts:generate`，再运行检查；生成文件需随 OpenAPI 提交。

```powershell
pnpm dev:api
```

默认仅绑定 127.0.0.1:3001，可用 HOST/PORT 调整。检查 `/api/v1/health/live` 为 200；缺数据库时 `/api/v1/health/ready` 和已实现身份接口为 503。配置流程见身份实现说明，迁移及依赖就绪后 ready 为 200。停止进程使用 Ctrl+C；测试使用随机本机端口并在完成后关闭。受限执行环境可能需要允许本机回环连接。

## 下一实施边界

本机没有系统级 Docker/PostgreSQL；数据库测试已通过项目内的 PostgreSQL 18 二进制完成，无需安装系统服务。测试包仅用于临时隔离测试，不作为生产数据库交付。没有部署或客户实例。

下一批补齐邀请/员工/角色、密码重设、通知任务与清理 Worker、店铺配置/市场审核，再接入后台页面及部署/恢复演练。现有首店主身份流程已接入实际数据库与 HTTP 控制器。客户端仅提供类型约束，没有对任意远端成功响应执行运行时 JSON Schema 验证。

当前目录仍未初始化 Git，GitHub Actions 文件尚未在远端运行；本地校验结果不能表述为 CI 已通过。
