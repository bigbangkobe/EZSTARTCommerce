# ===== 数据库（Docker 本地部署，仅本商户实例使用）=====
POSTGRES_USER=ezstart
POSTGRES_PASSWORD=
POSTGRES_DB=ezstart

# ===== 站点（本商户域名）=====
SITE_DOMAIN={{SITE_DOMAIN}}

# ===== API 身份安全参数（见 docs/IDENTITY_SECURITY_POLICY.md）=====
# 生成 UUID：node -e "console.log(crypto.randomUUID())"
INSTANCE_ID=
# 32 字节密钥 canonical base64。生成：openssl rand -base64 32
IDENTITY_ENCRYPTION_KEY=
# 可选：首店初始化引导令牌（32–512 字符），初始化完成后建议移除
BOOTSTRAP_TOKEN=

# ===== 通知 Worker SMTP =====
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=

# ===== 承运商状态回传（M09，可选）=====
# 未配置时所有承运商回调返回 404，不会误收未登记来源。
# 按承运商代码填共享密钥（每个至少 32 字符），需与承运商服务端约定同一串。
# 例：{"sf":"replace-with-carrier-shared-secret-at-least-32-chars"}
# 修改后需重建 API 容器：docker compose up -d --build api
CARRIER_WEBHOOK_SECRETS=

# ===== 内部定时任务（对账）=====
# 未配置时 /internal/jobs/* 一律 503，不会留下未受保护的运维入口。
# 生成：openssl rand -base64 36
# 配置后可用 `docker compose exec -T api node scripts/reconcile.mjs` 手动触发。
INTERNAL_JOB_TOKEN=
