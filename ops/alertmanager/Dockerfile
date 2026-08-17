# Alertmanager plus the two things its own image lacks: a shell utility to
# expand environment variables into the config, and an entrypoint that decides
# which kind of receiver to build.
#
# The upstream image is distroless-ish (busybox), so envsubst comes from a
# builder stage rather than a package install at runtime.
FROM alpine:3.21 AS tools
RUN apk add --no-cache gettext

FROM prom/alertmanager:v0.28.0

COPY --from=tools /usr/bin/envsubst /usr/bin/envsubst
COPY alertmanager.tmpl.yml /etc/alertmanager/alertmanager.tmpl.yml
COPY entrypoint.sh /entrypoint.sh

USER root
RUN chmod +x /entrypoint.sh
# Back to the unprivileged user the base image ships with.
USER nobody

ENTRYPOINT ["/entrypoint.sh"]
