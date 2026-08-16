#!/bin/sh
# Periodic logical backup of the primary database.
#
# Every other durability mechanism in this system protects a *message* — the
# outbox, the idempotency claim, the retry ladder. None of them survive losing
# the volume, which on a single-VM deployment is the failure that actually ends
# the service. This is the one that does.
#
# Runs as its own long-lived container rather than a host cron entry so the
# schedule ships with the stack instead of living in a machine nobody
# reprovisions.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
PGHOST="${PGHOST:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_SEC="${BACKUP_INTERVAL_SEC:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [backup] $*"
}

run_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="${BACKUP_DIR}/${POSTGRES_DB}_${stamp}.dump"

  log "dumping ${POSTGRES_DB} to ${target}"
  # Custom format: compressed already, and restorable table-by-table, which is
  # what a partial recovery needs. Written to .part first so a crash mid-dump
  # cannot leave a truncated file that looks like a finished backup.
  if ! pg_dump --format=custom --no-owner --no-acl \
    --host="$PGHOST" --username="$POSTGRES_USER" "$POSTGRES_DB" \
    --file="${target}.part"; then
    log "ERROR pg_dump failed"
    rm -f "${target}.part"
    return 1
  fi

  # An unverified backup is a guess. Reading the archive's table of contents is
  # cheap and catches a dump that completed but is unreadable — which is the
  # failure you otherwise discover on the day you need it.
  if ! pg_restore --list "${target}.part" > /dev/null 2>&1; then
    log "ERROR the dump is not a readable archive — discarding it"
    rm -f "${target}.part"
    return 1
  fi

  mv "${target}.part" "$target"
  log "wrote $(du -h "$target" | cut -f1) to ${target}"

  if [ -n "$BACKUP_S3_BUCKET" ]; then
    # A copy on the same volume as the database survives a dropped table, not a
    # lost VM. Off-site is what makes this a disaster-recovery plan rather than
    # an undo button.
    if aws s3 cp "$target" "s3://${BACKUP_S3_BUCKET}/$(basename "$target")"; then
      log "uploaded to s3://${BACKUP_S3_BUCKET}/"
    else
      # The local copy is already durable, so a failed upload is worth shouting
      # about but not worth discarding the backup over.
      log "ERROR upload to s3://${BACKUP_S3_BUCKET}/ failed — local copy kept"
    fi
  fi

  # Rotate after a successful dump, never before: pruning first would spend the
  # retention window on a run that then fails.
  removed=$(find "$BACKUP_DIR" -name "${POSTGRES_DB}_*.dump" -type f \
    -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | wc -l)
  if [ "$removed" -gt 0 ]; then
    log "pruned ${removed} backup(s) older than ${BACKUP_RETENTION_DAYS} days"
  fi
}

mkdir -p "$BACKUP_DIR"

# `once` takes a backup now and exits with its result — for an ad-hoc dump
# before a risky migration, and for CI to prove the path works rather than
# trusting that a container which stayed up did anything.
if [ "${1:-}" = "once" ]; then
  run_once
  exit $?
fi

log "starting: every ${BACKUP_INTERVAL_SEC}s, keeping ${BACKUP_RETENTION_DAYS} days${BACKUP_S3_BUCKET:+, mirroring to s3://$BACKUP_S3_BUCKET}"

while true; do
  # A failed run must not take the loop down with it — the next window is a
  # better answer than a container that exits and stops backing up entirely.
  run_once || log "run failed; retrying at the next interval"
  sleep "$BACKUP_INTERVAL_SEC"
done
