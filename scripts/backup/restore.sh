#!/bin/sh
# Restore the database from a dump written by backup.sh.
#
# A backup nobody has restored is a hypothesis. This is the procedure, kept next
# to the thing that produces the files so the two cannot drift, and written to
# be run against a scratch database as a drill — not only on the worst day.
#
# Usage, from the repository root:
#   docker compose stop core-api watcher notifier
#   docker compose run --rm -T db-backup /scripts/restore.sh /backups/<file>.dump
#   docker compose start core-api watcher notifier
#
# Restoring into the live database while the services hold connections leaves
# them talking to a half-replaced schema, which is why the stop comes first.
set -eu

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  echo "usage: restore.sh <path-to-dump>" >&2
  exit 64
fi
if [ ! -f "$DUMP" ]; then
  echo "no such dump: $DUMP" >&2
  exit 66
fi

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
PGHOST="${PGHOST:-postgres}"
# Restoring somewhere else is the safe default for a drill; point this at the
# live database only when that is genuinely what you mean.
TARGET_DB="${RESTORE_TARGET_DB:-$POSTGRES_DB}"

echo "restoring ${DUMP} into ${TARGET_DB} on ${PGHOST}"
if [ "$TARGET_DB" = "$POSTGRES_DB" ]; then
  echo "WARNING: this replaces the live database. Ctrl-C within 10s to abort."
  sleep 10
fi

psql --host="$PGHOST" --username="$POSTGRES_USER" --dbname=postgres \
  -v ON_ERROR_STOP=1 -c "SELECT 'noop'" > /dev/null

# --clean --if-exists rather than dropping the database itself: the role and the
# database may be owned by the platform, and this way the restore needs no
# privileges beyond the ones the application already has.
pg_restore --host="$PGHOST" --username="$POSTGRES_USER" --dbname="$TARGET_DB" \
  --clean --if-exists --no-owner --no-acl --exit-on-error "$DUMP"

echo "restored. Run 'npx prisma migrate deploy' if the dump predates the current migrations."
