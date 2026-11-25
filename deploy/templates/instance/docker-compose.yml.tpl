# IN先生 实例部署（{{SITE_DOMAIN}} · 商户专属）
# 服务器：AWS Lightsail 东京 35.79.20.20（Amazon Linux 2023，2 vCPU / 4GB）
# 用法：cp .env.example .env（填好密钥）&& docker compose up -d --build
# 注意：构建上下文为仓库根目录（../../../），共用 deploy/shared 的 Dockerfile。

name: ezstart-{{INSTANCE_ID}}

# api / migrate / worker 共用同一个镜像（Dockerfile.node）。
# 关键：migrate 与 worker 必须复用 api 的镜像标签，不能各自 build —— 否则只重建 api 时
# migrate 会静默沿用旧镜像，出现"迁移没跑，API 却要求新迁移"的启动拒绝。
x-node-build: &node-build
  context: ../../..
  dockerfile: deploy/shared/Dockerfile.node

services:
  # ---------- 数据库（本地 Docker 部署，不暴露公网） ----------
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-ezstart}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?请在 .env 设置 POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-ezstart}
    volumes:
      # PostgreSQL 18+ 建议把卷挂在 /var/lib/postgresql（数据在其子目录内，方便 pg_upgrade）
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-ezstart} -d ${POSTGRES_DB:-ezstart}"]
      interval: 10s
      timeout: 5s
      retries: 10
    # 数据库不对公网暴露。如需临时本机调试，取消下一行注释（仅绑定本机回环）：
    # ports: ["127.0.0.1:5432:5432"]

  # ---------- 一次性：数据库迁移（Prisma migrate deploy） ----------
  migrate:
    image: ezstart-{{INSTANCE_ID}}-api
    command: ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "packages/database/prisma.config.ts"]
    restart: "no"
    environment: &node-env
      DATABASE_URL: postgresql://${POSTGRES_USER:-ezstart}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-ezstart}
    depends_on:
      postgres:
        condition: service_healthy

  # ---------- 核心 API ----------
  api:
    build: *node-build
    image: ezstart-{{INSTANCE_ID}}-api
    command: ["node", "dist/apps/api/src/main.js"]
    restart: unless-stopped
    volumes:
      # 媒体文件落在宿主目录：本地驱动默认写容器内 /app/.data/media，容器重建即丢，
      # 而数据库里的 MediaAsset 记录还在 → 前台图片全部 404。按实例隔离目录，便于单独备份。
      - /opt/ezstart-{{INSTANCE_ID}}-media:/app/.data/media
    environment:
      <<: *node-env
      NODE_ENV: production
      PORT: "3001"
      HOST: "0.0.0.0"
      INSTANCE_ID: ${INSTANCE_ID:?请在 .env 设置 INSTANCE_ID}
      APP_ORIGIN: https://${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
      # 后台独立域名：写入来源校验与邀请/重设链接都用它，缺了后台登录会被 403
      ADMIN_ORIGIN: https://admin.${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
      IDENTITY_ENCRYPTION_KEY: ${IDENTITY_ENCRYPTION_KEY:?请在 .env 设置 IDENTITY_ENCRYPTION_KEY}
      BOOTSTRAP_TOKEN: ${BOOTSTRAP_TOKEN:-}
      # 后台是否强制二次验证。默认 true：店主/管理员必须绑定 TOTP。
      # 只有实例明确写 false 才关闭（店主只要「账号 + 密码」时用），改配置即可，不必改代码。
      ADMIN_REQUIRE_MFA: ${ADMIN_REQUIRE_MFA:-true}
      # 真实访客 IP：API 只在 Caddy 反代后面（compose 内网），不配这个所有访客看到的
      # 都是 Caddy 容器地址，全站共用一个限流桶——每 15 分钟 60 次写操作很快被用光，
      # 之后所有人的加购、改数量、会员登录码请求会一起 429。Caddy 默认追加 X-Forwarded-For，
      # 所以这里是 1 层；前面再加 CDN 就要同步调大。
      TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}
      # 承运商签名回传密钥 JSON；留空时所有承运商回调返回 404（安全默认）
      CARRIER_WEBHOOK_SECRETS: ${CARRIER_WEBHOOK_SECRETS:-}
      # 线上支付：这个地址是"顾客付完从哪里回来"的基址，缺了它整块线上支付不装配
      # （webhook 路由不存在、发起支付直接失败），配好渠道也用不了。默认取站点域名。
      PAYMENTS_BASE_URL: https://${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
      # production 实例固定 production，沙箱渠道（mock）只认 sandbox
      PAYMENTS_ENVIRONMENT: ${PAYMENTS_ENVIRONMENT:-production}
      # mock 网关签名密钥，仅 sandbox 环境使用；生产留空即可
      MOCK_PAYMENT_SECRET: ${MOCK_PAYMENT_SECRET:-}
      # 对账任务令牌：留空则 /internal/jobs/reconcile 返回 503（安全默认）。
      # 开通线上支付前必须配置，否则"渠道已扣款但回调丢失"的单永远收敛不了。
      INTERNAL_JOB_TOKEN: ${INTERNAL_JOB_TOKEN:-}
    depends_on:
      migrate:
        condition: service_completed_successfully
    # 容器内自检：DB 连不上时 ready 返回 503，compose 就不会把后台/前台挂上去
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- --timeout=3 http://127.0.0.1:3001/api/v1/health/ready >/dev/null || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s

  # ---------- 通知 Worker（需要完整 SMTP 配置，配好后用 --profile smtp 启动） ----------
  worker:
    profiles: ["smtp"]
    image: ezstart-{{INSTANCE_ID}}-api
    command: ["node", "dist/apps/worker/src/main.js"]
    restart: unless-stopped
    environment:
      <<: *node-env
      NODE_ENV: production
      APP_ORIGIN: https://${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
      ADMIN_ORIGIN: https://admin.${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
      INSTANCE_ID: ${INSTANCE_ID:?请在 .env 设置 INSTANCE_ID}
      IDENTITY_ENCRYPTION_KEY: ${IDENTITY_ENCRYPTION_KEY:?请在 .env 设置 IDENTITY_ENCRYPTION_KEY}
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      SMTP_FROM: ${SMTP_FROM:-}
    depends_on:
      migrate:
        condition: service_completed_successfully

  # ---------- 管理后台 ----------
  admin:
    build:
      context: ../../..
      dockerfile: deploy/shared/Dockerfile.next
      args:
        APP_DIR: apps/admin
        APP_NAME: "@ezstart/admin"
        # 必须与下面 environment 里的 API_INTERNAL_ORIGIN 一致：该地址会被写进构建产物
        API_INTERNAL_ORIGIN: http://api:3001
    restart: unless-stopped
    environment:
      NODE_ENV: production
      API_INTERNAL_ORIGIN: http://api:3001
    depends_on:
      api:
        condition: service_healthy

  # ---------- IN先生 顾客前台 ----------
  storefront:
    build:
      context: ../../..
      dockerfile: deploy/shared/Dockerfile.next
      args:
        APP_DIR: apps/storefront-{{INSTANCE_ID}}
        APP_NAME: "@ezstart/storefront-{{INSTANCE_ID}}"
        API_INTERNAL_ORIGIN: http://api:3001
    command: ["node", "../../node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3002"]
    restart: unless-stopped
    environment:
      NODE_ENV: production
      API_INTERNAL_ORIGIN: http://api:3001
    depends_on:
      api:
        condition: service_healthy

  # ---------- 反向代理 + 自动 HTTPS（Let's Encrypt） ----------
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      SITE_DOMAIN: ${SITE_DOMAIN:?请在 .env 设置 SITE_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - admin
      - storefront

volumes:
  pgdata:
  caddy_data:
  caddy_config:
