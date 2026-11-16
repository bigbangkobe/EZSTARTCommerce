# 接口契约校验

`openapi.yaml` 是 OpenAPI 3.1 草稿；当前仍有通用响应占位，不能视为已冻结或已有服务端实现。

在项目根目录用 Python 3.11 安装项目本地的校验依赖并执行：

```powershell
python -m pip install --target .local-tools/contract-validation -r packages/contracts/requirements-validation.txt
$env:PYTHONPATH = (Resolve-Path '.local-tools/contract-validation').Path
python -m unittest discover -s packages/contracts -p 'test_*.py' -v
```

校验包括 OpenAPI 结构/引用、operationId 唯一性、后台权限标签，以及报价到下单、OTP 挑战、联系资料和商品规格响应的 JSON Schema 正反例。R1 额外检查具体响应覆盖、后台 MFA/员工状态、员工与角色分页、市场审核、配置版本、ETag/If-Match 声明和密码重设响应。业务运行时的库存、支付、身份验证和权限执行仍须集成测试。

修改响应 DTO 时同步 [API 规格](../../docs/API_SPEC.md)、[用例矩阵](../../docs/TEST_CASES.md)和契约回归；不得以通用对象通过结构校验作为接口完整的证据。

后台身份流程与部署/邀请/MFA/会话凭据边界见 [生命周期契约](../../docs/ADMIN_IDENTITY_LIFECYCLE.md)。安全默认值和邀请重发/撤销契约已登记；首店主数据库/HTTP 身份子流程已交付本地验证，邀请/找回/离线恢复等仍待交付。

根目录 `pnpm contracts:generate` 生成 `generated/api.d.ts`；`pnpm contracts:check` 检查源契约与生成文件无漂移。`src/client.ts` 的登录请求/联合响应类型来自生成文件；应用使用 TypeScript 6 检查，生成工具隔离使用其支持的 TypeScript 5.9。统一执行入口为根目录 `pnpm check`。
