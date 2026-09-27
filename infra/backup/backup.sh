#!/bin/sh
# Daily backup: PostgreSQL dump + uploaded files, with retention.
# Runs inside the `backup` service (docker-compose.prod.yml). Output: /backups on the host.
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"

run_backup() {
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  dir="/backups/${stamp}"
  mkdir -p "${dir}"
  echo "[backup] ${stamp}: dumping database"
  # Custom format: compressed, restorable table by table with pg_restore.
  PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=custom --no-owner --file="${dir}/database.dump"
  if [ -d /storage ] && [ "$(ls -A /storage 2>/dev/null)" ]; then
    echo "[backup] ${stamp}: archiving uploaded files"
    tar -czf "${dir}/storage.tar.gz" -C /storage .
  fi
  # Integrity check: the dump must list its contents.
  pg_restore --list "${dir}/database.dump" > /dev/null
  du -sh "${dir}" | awk '{print "[backup] size " $1}'
  touch "${dir}/COMPLETE"
  echo "[backup] ${stamp}: done"
  find /backups -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true
}

if [ "${1:-}" = "once" ]; then
  run_backup
  exit 0
fi

echo "[backup] every ${INTERVAL_HOURS}h, keeping ${KEEP_DAYS} days"
while true; do
  run_backup || echo "[backup] FAILED at $(date -u)" >&2
  sleep "$((INTERVAL_HOURS * 3600))"
done
