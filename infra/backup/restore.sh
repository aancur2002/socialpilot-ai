#!/bin/sh
# Restores a backup made by backup.sh. Replaces the current database and files.
#   docker compose -f docker-compose.prod.yml stop api worker web
#   docker compose -f docker-compose.prod.yml exec backup /scripts/restore.sh 20261001-020000
#   docker compose -f docker-compose.prod.yml start api worker web
set -eu

name="${1:-}"
if [ -z "${name}" ]; then
  echo "Usage: restore.sh <backup folder name>. Available:" >&2
  ls -1 /backups >&2
  exit 1
fi
dir="/backups/${name}"
[ -f "${dir}/database.dump" ] || { echo "No database.dump in ${dir}" >&2; exit 1; }
[ -f "${dir}/COMPLETE" ] || { echo "${dir} is incomplete (the backup did not finish)" >&2; exit 1; }

if [ "${CONFIRM:-}" != "yes" ]; then
  printf "This replaces the current database%s with %s. Type yes to continue: " "$( [ -f "${dir}/storage.tar.gz" ] && echo ' and uploaded files')" "${name}"
  read -r answer
  [ "${answer}" = "yes" ] || { echo "Cancelled."; exit 1; }
fi

echo "[restore] database"
PGPASSWORD="${POSTGRES_PASSWORD}" pg_restore -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --clean --if-exists --no-owner --single-transaction "${dir}/database.dump"
if [ -f "${dir}/storage.tar.gz" ] && [ -d /storage ]; then
  echo "[restore] uploaded files"
  find /storage -mindepth 1 -delete
  tar -xzf "${dir}/storage.tar.gz" -C /storage
fi
echo "[restore] done. Start the app again."
