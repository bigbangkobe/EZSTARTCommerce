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

## 通知 Worker（SMTP）：会员登录码／邀请／密码重设

前台「會員登入」不设密码，只发一次性验证码。API 里发码这一步只做两件事：写一条
`MemberOtpChallenge` 和一个 `IdentityNotificationJob`（`kind=member_otp`），**真正的 SMTP 投递由 worker 完成**。
所以没配 SMTP 或 worker 没跑，客人永远收不到验证码，而页面仍显示「验证码已寄至」（`202` 只代表已排队）。

compose 里 worker 用 `profiles: ["smtp"]` 定义，默认 `docker compose up -d` 不会拉起它：

```bash
# 1) 先在 .env 填好五项（缺一项 worker 会以 identity_worker.start_failed 退出）
#    SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM
# 2) 带 profile 启动（deploy.sh 检测到 SMTP_HOST 会自动带上 profile）
docker compose --profile smtp up -d worker
docker compose logs -f worker      # 期望看到 {"event":"identity_worker.started"}
```

验证投递：后台 `https://admin.<域名>/admin/settings` 的「邮件自检」，填真实收件地址，
状态由 `pending` 变 `sent` 即链路通。排查用：

```sql
SELECT kind, status, attempts, "createdAt" FROM "IdentityNotificationJob"
 WHERE kind = 'member_otp' ORDER BY "createdAt" DESC LIMIT 10;
```

`pending` 长期不动 = worker 没启动；`failed` = SMTP 拒投（重试 30/60/120/240 秒，第 5 次失败后终止
并清除密文，只能请客人重新申请验证码）。另有三条口径要记住：验证码有效期 10 分钟、同邮箱 60 秒冷却、
每邮箱每小时最多 5 封；重发会作废旧码。域名务必配 SPF、DKIM、DMARC，`SMTP_FROM` 用供应商验证过的寄件地址，
否则邮件会被退信或丢进垃圾箱。

## 安全基线

- PostgreSQL / API / worker 不暴露公网端口，唯一入口是 Caddy 80/443。
- API 经 Caddy 反代，compose 里 `TRUSTED_PROXY_HOPS=1`：限流与审计按真实访客 IP 计。不配会让全站共用一个
  限流桶（每 15 分钟 60 次写操作，加购与会员登录码会一起 429）；前面再加 CDN 时要同步调成 2 层。
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
