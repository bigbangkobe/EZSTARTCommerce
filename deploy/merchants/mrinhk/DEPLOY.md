# IN先生 实例部署手册（mrinhk.com）

## 服务器信息

| 项 | 值 |
|---|---|
| 云 | AWS Lightsail 东京 ap-northeast-1 |
| IP | 35.79.20.20 |
| 系统 | Amazon Linux 2023 |
| 规格 | 2 vCPU / 4GB / 100GB |
| SSH | `ssh -i ~/.ssh/in.pem ec2-user@35.79.20.20` |
| 代码目录 | `/opt/ezstart-mrinhk`（git clone，`main` 分支跟踪 origin） |
| 代码仓库 | `git@github.com:bigbangkobe/EZSTARTCommerce.git` |
| 密钥文件（本地） | `D:/Projects/OneNeXX/资料/AWS/IN.pem` |

## 部署步骤

1. **DNS**：Route 53 把 `mrinhk.com`、`www.mrinhk.com`、`admin.mrinhk.com` 的 A 记录指向 `35.79.20.20`。
2. **取代码**：`sudo git clone https://github.com/bigbangkobe/EZSTARTCommerce.git /opt/ezstart-mrinhk`，并把目录属主改为 `ec2-user`。
3. **配置**：`cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk && cp .env.example .env`，填入生成的密钥（`chmod 600 .env`）。
4. **启动**：`./deploy.sh --no-pull`（详见下方「日常发布」）。
5. **验证**：`https://mrinhk.com`（前台）、`https://admin.mrinhk.com`（后台）、`https://mrinhk.com/api/v1/health/live`（接口）。

## 日常发布（一键）

```bash
cd /opt/ezstart-mrinhk/deploy/merchants/mrinhk
./deploy.sh              # 备份库 → git pull → 重建镜像 → 启动 → 等 API 健康 → 公网冒烟
./deploy.sh --no-pull    # 只重建当前代码，不拉取（改过本地文件时用）
./deploy.sh --rollback   # 回滚到上次部署前的镜像（数据库不回滚，迁移只前进）
```

脚本行为：部署前把当前 `api/admin/storefront` 镜像打上 `:prev` 标签作为回滚点；`pg_dump` 备份到 `/opt/ezstart-backups`（保留 14 份）；API 未通过 `/api/v1/health/ready` 健康检查会打印日志并以非 0 退出。

> 本地改完先 `git push origin main`，服务器上才有得拉。

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

## 媒体文件（容易丢，单独说一遍）

商品图片存在宿主目录 **`/opt/ezstart-media`**，由 `docker-compose.yml` 的 `api.volumes` 挂载到容器的 `/app/.data/media`。
不挂这个卷的话，每次发布重建容器都会把图片清空，而数据库里的 `MediaAsset` 记录还在——前台图片全部 404，且无法自愈。

```bash
du -sh /opt/ezstart-media                 # 当前约 25 MB / 543 个文件
find /opt/ezstart-media -type f | wc -l   # 文件数应与 MediaAsset 表行数一致
```

**媒体已纳入每日自动备份**：systemd timer 每天 03:10 跑 `scripts/backup-instance.sh`，内容不变则跳过，
产物在 `/opt/ezstart-backups/media-<日期>.tar.gz`（保留 4 份）。手工补一份：

```bash
sudo tar czf /opt/ezstart-backups/media-$(date +%F).tar.gz -C /opt ezstart-media
```

恢复媒体：解包到 `/opt` 即可（包内路径前缀是 `ezstart-media/`）：

```bash
sudo tar xzf /opt/ezstart-backups/media-2026-11-24-0545.tar.gz -C /opt
docker compose restart api   # 让驱动重新打开文件句柄
```
