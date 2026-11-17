# IN先生 实例部署手册（mrinhk.com）

## 服务器信息

| 项 | 值 |
|---|---|
| 云 | AWS Lightsail 东京 ap-northeast-1 |
| IP | 35.79.20.20 |
| 系统 | Amazon Linux 2023 |
| 规格 | 2 vCPU / 4GB / 100GB |
| SSH | `ssh -i ~/.ssh/in.pem ec2-user@35.79.20.20` |
| 代码目录 | `/opt/ezstart-mrinhk` |
| 密钥文件（本地） | `D:/Projects/OneNeXX/资料/AWS/IN.pem` |

## 部署步骤

1. **DNS**：Route 53 把 `mrinhk.com` 和 `admin.mrinhk.com` 的 A 记录指向 `35.79.20.20`。
2. **上传代码**：本地执行（见 DEPLOY.md 对应命令）或 git clone 到 `/opt/ezstart-mrinhk`。
3. **配置**：`cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk && cp .env.example .env`，填入生成的密钥。
4. **启动**：`docker compose up -d --build`。
5. **验证**：`https://mrinhk.com`（前台）、`https://admin.mrinhk.com`（后台）。

## 运维命令（在该商户目录下执行）

```bash
docker compose ps                        # 状态
docker compose logs -f api               # API 日志
docker compose up -d --build api         # 只重建 API
docker compose exec postgres pg_dump -U ezstart ezstart | gzip > backup_$(date +%F).sql.gz  # 备份
gunzip -c backup_YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U ezstart ezstart  # 恢复
```

## 安全基线

- PostgreSQL / API / worker 不暴露公网端口，唯一入口是 Caddy 80/443。
- `.env` 权限 `chmod 600`，不进 Git。
- Lightsail 控制台开启每日自动快照；上线前做一次备份恢复演练。
- 本商户实例数据只属于 IN先生，不得与其他商户实例交叉访问。
