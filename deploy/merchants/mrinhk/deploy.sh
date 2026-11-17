#!/usr/bin/env bash
# IN先生 实例一键部署：备份库 → 拉代码 → 重建镜像 → 启动 → 健康校验
#
# 用法（在服务器本目录下执行）：
#   ./deploy.sh              正常部署（git pull + build + up）
#   ./deploy.sh --no-pull    只重建当前代码，不拉取
#   ./deploy.sh --rollback   回滚到上一次部署前的镜像
#
# 约定：.env 不入库，部署前必须已存在；数据库备份默认放 /opt/ezstart-backups，保留 14 份。
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPO_ROOT="$(cd ../../.. && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/opt/ezstart-backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-14}"
DOMAIN="$(grep -E '^SITE_DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "✗ $*"; exit 1; }
trap 'die "第 ${LINENO} 行命令出错，部署中断"' ERR

# 允许以普通用户执行：没有 docker 权限时自动加 sudo
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
dc() { $DOCKER compose "$@"; }

MODE="deploy"
case "${1:-}" in
  --no-pull) MODE="no-pull" ;;
  --rollback) MODE="rollback" ;;
  "") ;;
  *) die "未知参数：$1（可用：--no-pull | --rollback）" ;;
esac

[ -f .env ] || die "缺少 .env：请先 cp .env.example .env 并填好密钥"
dc config -q || die "docker-compose.yml 校验失败"

# ---------------- 回滚 ----------------
if [ "$MODE" = "rollback" ]; then
  for svc in api admin storefront; do
    if $DOCKER image inspect "ezstart-mrinhk-${svc}:prev" >/dev/null 2>&1; then
      $DOCKER tag "ezstart-mrinhk-${svc}:prev" "ezstart-mrinhk-${svc}"
      log "已把 $svc 回退到 prev 镜像"
    else
      log "跳过 $svc：没有 prev 镜像"
    fi
  done
  dc up -d --no-build
  log "回滚完成（数据库不回滚，迁移只前进）"
  exit 0
fi

# ---------------- 1. 记录当前镜像，供回滚 ----------------
for svc in api admin storefront; do
  if $DOCKER image inspect "ezstart-mrinhk-${svc}" >/dev/null 2>&1; then
    $DOCKER tag "ezstart-mrinhk-${svc}" "ezstart-mrinhk-${svc}:prev"
  fi
done
log "已记录回滚点（镜像 tag :prev）"

# ---------------- 2. 备份数据库（migrate 之前） ----------------
if dc ps --status running --services 2>/dev/null | grep -qx postgres; then
  if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR" 2>/dev/null || sudo mkdir -p "$BACKUP_DIR"
  fi
  [ -w "$BACKUP_DIR" ] || sudo chown "$(id -u):$(id -g)" "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  TARGET="$BACKUP_DIR/ezstart-$STAMP.sql.gz"
  log "备份数据库 → $TARGET"
  dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$TARGET"
  [ -s "$TARGET" ] || die "备份文件为空，终止部署"
  ls -1t "$BACKUP_DIR"/ezstart-*.sql.gz | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -f
else
  log "postgres 未运行，跳过备份（首次部署）"
fi

# ---------------- 3. 拉代码 ----------------
if [ "$MODE" = "deploy" ]; then
  cd "$REPO_ROOT"
  log "拉取代码：$(git remote get-url origin 2>/dev/null || echo '无 origin')"
  git fetch --prune origin
  git merge --ff-only origin/main || die "无法快进合并，服务器上有本地改动，请先处理"
  log "当前版本：$(git log --oneline -1)"
  cd - >/dev/null
fi

# ---------------- 4. 重建并启动 ----------------
log "构建镜像（首次或依赖变更时较慢）"
dc build api admin storefront
log "启动服务"
dc up -d

# ---------------- 5. 等 API 健康 ----------------
log "等待 API 健康检查通过（最多 180 秒）"
for _ in $(seq 1 36); do
  STATUS="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ezstart-mrinhk-api-1 2>/dev/null || echo missing)"
  [ "$STATUS" = "healthy" ] && break
  sleep 5
done
[ "${STATUS:-}" = "healthy" ] || { dc logs --tail 40 api; die "API 未通过健康检查（状态：${STATUS:-unknown}）"; }
log "API 健康"

# ---------------- 6. 公网冒烟 ----------------
if [ -n "$DOMAIN" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/api/v1/health/live" || true)"
  [ "$CODE" = "200" ] || die "公网接口冒烟失败：https://$DOMAIN/api/v1/health/live → $CODE"
  log "公网冒烟通过：https://$DOMAIN/api/v1/health/live → 200"
else
  log "未读到 SITE_DOMAIN，跳过公网冒烟"
fi

log "✅ 部署完成：$(cd "$REPO_ROOT" && git log --oneline -1 2>/dev/null || echo '（非 git 目录）')"
$DOCKER ps --filter "name=ezstart-mrinhk-" --format '  {{.Names}}\t{{.Status}}'
