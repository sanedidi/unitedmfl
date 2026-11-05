#!/usr/bin/env bash
# Daily backup: database dump + uploaded files. Add to cron:
#   0 3 * * * /opt/unitedmfl/deploy/backup.sh >> /var/log/unitedmfl-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
OUT="${BACKUP_DIR:-/var/backups/unitedmfl}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
docker compose exec -T db pg_dump -U unitedmfl -d unitedmfl --format=custom > "$OUT/db-$STAMP.dump"
docker compose exec -T api tar -C /data -czf - uploads > "$OUT/uploads-$STAMP.tar.gz"
find "$OUT" -type f -mtime +14 -delete
echo "backup ok: $OUT ($STAMP)"
