# Backup sidecar: pg_dump/pg_restore plus the AWS CLI for the off-site copy.
#
# Built on the same Postgres image the database runs, so the dump utilities
# match the server version exactly — pg_dump refuses to dump a server newer
# than itself, and a version skew here surfaces as a backup that silently
# stopped running.
FROM postgres:16-alpine

# `aws` is only reached when BACKUP_S3_BUCKET is set; it is installed
# unconditionally so enabling off-site copies is a variable, not a rebuild.
RUN apk add --no-cache aws-cli

COPY backup.sh restore.sh /scripts/
RUN chmod +x /scripts/backup.sh /scripts/restore.sh

# Created here, before dropping root, because Docker seeds a fresh named volume
# from the image's directory — ownership included. Without this the volume
# mounts as root:root and the unprivileged process cannot write its first dump.
RUN mkdir -p /backups && chown postgres:postgres /backups

# The postgres image ships an unprivileged `postgres` user; nothing here needs
# root once the directory exists.
USER postgres

CMD ["/scripts/backup.sh"]
