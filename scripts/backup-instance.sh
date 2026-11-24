#!/usr/bin/env bash
# EZSTART 实例每日备份：数据库 dump + 媒体快照 → 校验 → 保留 N 份 →（可选）上传对象存储。
#
# 为什么媒体也要备份：商品图存在宿主目录（compose 里挂给 api 的 /opt/ezstart-media），
# 数据库只存 MediaAsset 元数据。只备数据库的话，恢复后图片全部 404，且无法自愈。
#
# 由 systemd timer 调用（见 docs/05-部署运维文档/AWS_ENVIRONMENTS.md 6.4）：
#   ExecStart=/opt/ezstart-mrinhk/scripts/backup-instance.sh
# 实例差异全部走环境变量（可用 EnvironmentFile 提供），脚本本身与实例无关。
set -Eeuo pipefail

STAMP="${STAMP:-$(date +%F-%H%M)}"
DIR="${BACKUP_DIR:-/opt/ezstart-backups}"
KEEP="${KEEP_BACKUPS:-14}"
CONTAINER="${PG_CONTAINER:-ezstart-mrinhk-postgres-1}"
DB_USER="${PG_USER:-ezstart}"
DB_NAME="${PG_DB:-ezstart}"
MEDIA_DIR="${MEDIA_DIR:-/opt/ezstart-media}"
MEDIA_KEEP="${MEDIA_KEEP:-4}"
LOG="$DIR/backup.log"

mkdir -p "$DIR"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------------------
# 1. 数据库
# ---------------------------------------------------------------------------
DB_FILE="$DIR/ezstart-$STAMP.dump"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f /tmp/ezstart.dump
docker cp "$CONTAINER:/tmp/ezstart.dump" "$DB_FILE"
docker exec "$CONTAINER" rm -f /tmp/ezstart.dump
chmod 600 "$DB_FILE"

# 校验不是走形式：能列出 dump 目录才说明这份备份可用，截断的 dump 一律算失败。
docker cp "$DB_FILE" "$CONTAINER:/tmp/verify.dump"
docker exec "$CONTAINER" pg_restore -l /tmp/verify.dump > /tmp/verify.list
docker exec "$CONTAINER" rm -f /tmp/verify.dump
TABLES=$(grep -c 'TABLE DATA' /tmp/verify.list || true)
rm -f /tmp/verify.list
log "db ok: $(basename "$DB_FILE") $(stat -c %s "$DB_FILE") bytes, ${TABLES} table data entries"

DB_COUNT=$(ls -1t "$DIR"/ezstart-*.dump 2>/dev/null | wc -l)
if [ "$DB_COUNT" -gt "$KEEP" ]; then
  ls -1t "$DIR"/ezstart-*.dump | tail -n "+$((KEEP + 1))" | xargs -r rm -f
  log "db pruned to $KEEP copies"
fi

# ---------------------------------------------------------------------------
# 2. 媒体快照
# 媒体很少变（上架商品时才动），每天全量 tar 一份既浪费又看不出变化。
# 用「路径+大小」指纹判断是否变化：变了就打，没变就跳过（周日强制打一份兜底）。
# ---------------------------------------------------------------------------
MEDIA_STATE="$DIR/media.state"
MEDIA_FILE="$DIR/media-$STAMP.tar.gz"
if [ -d "$MEDIA_DIR" ]; then
  FINGERPRINT=$(find "$MEDIA_DIR" -type f -printf '%P %s\n' 2>/dev/null | sort | sha256sum | cut -c1-16)
  LAST=$(cat "$MEDIA_STATE" 2>/dev/null || echo none)
  if [ "$FINGERPRINT" != "$LAST" ] || [ "$(date +%u)" = "7" ]; then
    tar czf "$MEDIA_FILE" -C "$(dirname "$MEDIA_DIR")" "$(basename "$MEDIA_DIR")"
    chmod 600 "$MEDIA_FILE"
    # 校验：能列出条目才算成功
    ENTRIES=$(tar tzf "$MEDIA_FILE" | wc -l)
    if [ "$ENTRIES" -lt 2 ]; then
      log "media snapshot SUSPECT: $(basename "$MEDIA_FILE") 只有 ${ENTRIES} 个条目"
      exit 3
    fi
    echo "$FINGERPRINT" > "$MEDIA_STATE"
    log "media ok: $(basename "$MEDIA_FILE") $(stat -c %s "$MEDIA_FILE") bytes, ${ENTRIES} entries (changed)"
  else
    log "media unchanged since last snapshot (fingerprint $FINGERPRINT), skipped"
  fi
  MEDIA_COUNT=$(ls -1t "$DIR"/media-*.tar.gz 2>/dev/null | wc -l)
  if [ "$MEDIA_COUNT" -gt "$MEDIA_KEEP" ]; then
    ls -1t "$DIR"/media-*.tar.gz | tail -n "+$((MEDIA_KEEP + 1))" | xargs -r rm -f
    log "media pruned to $MEDIA_KEEP copies"
  fi
else
  log "media dir $MEDIA_DIR 不存在（本实例可能用对象存储），跳过媒体快照"
fi

# ---------------------------------------------------------------------------
# 3. 可选：上传对象存储（桶与凭据由运维提供，未配置时只留本机）
# ---------------------------------------------------------------------------
if [ -n "${BACKUP_BUCKET:-}" ]; then
  upload() {
    local file="$1"
    if aws s3 cp "$file" "$BACKUP_BUCKET/$(basename "$file")" --sse AES256 >>"$LOG" 2>&1; then
      log "uploaded $(basename "$file")"
    else
      log "upload FAILED: $(basename "$file")（副本仍在 $DIR）"
      return 1
    fi
  }
  upload "$DB_FILE" || exit 2
  [ -f "$MEDIA_FILE" ] && { upload "$MEDIA_FILE" || exit 2; }
else
  log "BACKUP_BUCKET 未配置：仅本机备份，异机备份仍未完成"
fi
