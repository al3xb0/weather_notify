#!/bin/sh
# Render alertmanager.yml from the template, then exec Alertmanager.
#
# Two things force this. Alertmanager expands no environment variables in its
# config, and which receiver to build is a decision rather than a value: a
# webhook and an email receiver have different shapes, so the choice cannot be
# a placeholder.
set -eu

TEMPLATE=/etc/alertmanager/alertmanager.tmpl.yml
RENDERED=/tmp/alertmanager.yml

ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-${MAIL_FROM:-alerts@example.com}}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_REQUIRE_TLS="${SMTP_SECURE:-true}"

# A webhook wins when both are set: it is the one that reaches a phone.
if [ -n "$ALERT_WEBHOOK_URL" ]; then
  RECEIVER_BODY="    webhook_configs:
      - url: '${ALERT_WEBHOOK_URL}'
        send_resolved: true"
  echo "alertmanager: notifying by webhook"
elif [ -n "$ALERT_EMAIL_TO" ] && [ -n "$SMTP_HOST" ]; then
  RECEIVER_BODY="    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        send_resolved: true"
  echo "alertmanager: notifying ${ALERT_EMAIL_TO} by email"
else
  # Deliberately loud. A receiver that silently drops everything looks exactly
  # like a system with no alerts, which is the failure this whole service
  # exists to prevent.
  RECEIVER_BODY=""
  echo "alertmanager: WARNING — no ALERT_WEBHOOK_URL and no ALERT_EMAIL_TO/SMTP_HOST."
  echo "alertmanager: alerts will fire and be visible in the UI, but reach nobody."
fi

export ALERT_EMAIL_FROM SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS \
  SMTP_REQUIRE_TLS RECEIVER_BODY

# envsubst restricted to the names we set, so an unrelated ${...} in the
# template — Alertmanager's own Go templating, for instance — survives intact.
envsubst '
  ${ALERT_EMAIL_FROM} ${SMTP_HOST} ${SMTP_PORT} ${SMTP_USER} ${SMTP_PASS}
  ${SMTP_REQUIRE_TLS} ${RECEIVER_BODY}
' < "$TEMPLATE" > "$RENDERED"

exec /bin/alertmanager --config.file="$RENDERED" "$@"
