# 多商户独立部署总览

EZSTARTCommerce 面向多个商家逐家独立私有部署（见 docs/PRIVATE_DEPLOYMENT.md）。本目录按「**一个商户 = 一个目录 = 一个独立实例**」管理，各商户配置互不影响，新增公司照抄模板即可。

## 目录结构

```
deploy/
├── shared/                    # 共用镜像构建（所有商户使用同一套）
│   ├── Dockerfile.node        # API / Worker / 数据库迁移镜像
│   └── Dockerfile.next        # Next.js 应用镜像（admin / 各商户前台共用）
└── merchants/
    ├── mrinhk/                # IN先生 实例（mrinhk.com）
    │   ├── docker-compose.yml # 该商户的完整服务编排
    │   ├── Caddyfile          # 该商户域名与 HTTPS
    │   ├── .env.example       # 该商户密钥/环境变量模板
    │   └── DEPLOY.md          # 该商户服务器部署手册
    └── <next-merchant>/       # 未来其他公司，逐家复制新增
```

## 隔离原则（必须遵守）

- **一台服务器（一个独立实例）服务一个商户**；实例间数据库、媒体文件、账号、密钥、备份完全隔离。
- 各商户 `.env` 永远放在各自目录下，**不进 Git**（只有 `.env.example` 模板入库）。
- 商户间不通数据、不共享管理员账号；运维操作前必须确认目标商户目录。
- 商户前台代码在 `apps/storefront-<merchant>`，按客户单独开发；核心（api/admin/worker）共用同一套镜像构建。

## 新增一个商户的步骤

1. 复制模板：`cp -r merchants/mrinhk merchants/<新商户>`
2. 修改该商户目录下：
   - `docker-compose.yml` 中的 `name:`（compose 项目名）、`.env` 里的 `SITE_DOMAIN`、`POSTGRES_*`
   - `Caddyfile` 中的域名（如 `xxx.com` / `admin.xxx.com`）
   - `DEPLOY.md` 中的服务器 IP / 用户 / 密钥
3. 新建商户前台：复制 `apps/storefront-mrinhk` → `apps/storefront-<新商户>`，改 `lib/site.ts`（品牌/域名/WhatsApp）与样式，并把 compose 里 storefront 的 `APP_DIR` / `APP_NAME` 指向新目录
4. 重新生成该商户的密钥（INSTANCE_ID、IDENTITY_ENCRYPTION_KEY、POSTGRES_PASSWORD）——**严禁跨商户复用**
5. DNS 指向该商户自己的服务器，`docker compose up -d --build`

## 服务器清单

| 商户 | 域名 | 服务器 IP | 系统 | 状态 |
|---|---|---|---|---|
| IN先生 (mrinhk) | mrinhk.com | 35.79.20.20 | Amazon Linux 2023 | 部署中 |
| （下一个） | | | | |
