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

## 支付对账（开通线上支付前必做）

线上支付依赖两个环境变量，**必须出现在 `docker-compose.yml` 的 `api.environment` 里**，
只写 `.env` 不会进容器：

- `PAYMENTS_BASE_URL`：模板已从 `SITE_DOMAIN` 推导，无需手工配。
  缺了它线上支付整体不装配（webhook 路由不存在），表现为莫名 404。
- `INTERNAL_JOB_TOKEN`：对账端点的令牌，`openssl rand -hex 32` 生成。留空则端点 503。

挂定时任务（每 10 分钟）：

```ini
# /etc/systemd/system/ezstart-reconcile.service
[Unit]
Description={{INSTANCE_ID}} 支付对账
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
User=<实例属主>
WorkingDirectory=<实例目录>
ExecStart=/usr/bin/docker compose exec -T api node scripts/reconcile.mjs
TimeoutStartSec=300

# /etc/systemd/system/ezstart-reconcile.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
Unit=ezstart-reconcile.service
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ezstart-reconcile.timer
sudo journalctl -u ezstart-reconcile.service -n 20   # 每轮只打印计数
```

## 安全基线

- PostgreSQL / API / worker 不暴露公网端口，唯一入口是 Caddy 80/443。
- `.env` 权限 `600`，密钥由工具链生成，禁止跨实例复用。
- 本实例数据只属于当前商户，不得与其他实例交叉访问。

> 本手册为产品交付参考，具体实施请结合公司合规与法务要求确认。
