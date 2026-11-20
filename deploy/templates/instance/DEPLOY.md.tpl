# {{SITE_DOMAIN}} 实例部署手册

> 本目录由交付工具链从实例配置源生成。改配置请改 `instance.yaml` 后重新构建包，
> 不要直接改这里生成的 compose / Caddyfile（会被下次构建覆盖）。

## 实例信息

| 项 | 值 |
|---|---|
| 实例 ID | `{{INSTANCE_ID}}` |
| 前台域名 | `{{SITE_DOMAIN}}` |
| 后台域名 | `admin.{{SITE_DOMAIN}}` |
| 前台应用 | `apps/{{STOREFRONT_APP}}` |
| compose 项目 | `ezstart-{{INSTANCE_ID}}` |

## 首次部署

1. 确认 `.env` 已生成且权限为 `600`（`ls -l .env`）；**绝不能把 .env 提交到 Git**。
2. 校验配置：`pnpm instance:validate instance.yaml --require-launch-ready`
3. 启动：`./deploy.sh --no-pull`
4. 验证：`https://{{SITE_DOMAIN}}`（前台）、`https://admin.{{SITE_DOMAIN}}`（后台）、
   `https://{{SITE_DOMAIN}}/api/v1/health/live`（接口）。

## 日常发布与回滚

```bash
./deploy.sh              # 备份库 → git pull → 重建镜像 → 启动 → 健康检查 → 冒烟
./deploy.sh --no-pull    # 只重建当前代码
./deploy.sh --rollback   # 回退 api/admin/storefront 到 :prev 镜像（数据库不回滚）
```

脚本行为：部署前把当前镜像打 `:prev` 标签；`pg_dump` 备份到 `BACKUP_DIR`（默认
`/opt/ezstart-backups`，保留 14 份）；API 未通过 `/api/v1/health/ready` 会打印日志并以非 0 退出。

## 安全基线

- PostgreSQL / API / worker 不暴露公网端口，唯一入口是 Caddy 80/443。
- `.env` 权限 `600`，密钥由工具链生成，禁止跨实例复用。
- 本实例数据只属于当前商户，不得与其他实例交叉访问。

> 本手册为产品交付参考，具体实施请结合公司合规与法务要求确认。
