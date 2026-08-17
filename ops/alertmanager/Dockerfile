# Alertmanager plus the two things its own image lacks: a shell utility to
# expand environment variables into the config, and an entrypoint that decides
# which kind of receiver to build.
#
# Built the other way round from the obvious arrangement — Alpine as the base
# with the binary copied in, rather than the upstream image with envsubst
# copied in. The upstream image is busybox with no libc at the paths a musl
# binary looks for, so a copied-in `envsubst` is a file that exists and cannot
# execute: the entrypoint died on `envsubst: not found` with the binary sitting
# right there, and the container had been crash-looping ever since. Alertmanager
# is a static Go binary and does not care what it runs on, so it is the half
# that travels.
FROM alpine:3.21

RUN apk add --no-cache gettext

COPY --from=prom/alertmanager:v0.28.0 /bin/alertmanager /bin/alertmanager
COPY --from=prom/alertmanager:v0.28.0 /bin/amtool /bin/amtool
COPY alertmanager.tmpl.yml /etc/alertmanager/alertmanager.tmpl.yml
COPY entrypoint.sh /entrypoint.sh

# The storage path the upstream image ships, kept so the volume mount and the
# --storage.path default below still line up.
RUN mkdir -p /alertmanager \
  && chown -R nobody:nobody /alertmanager /etc/alertmanager \
  && chmod +x /entrypoint.sh

USER nobody
EXPOSE 9093
VOLUME ["/alertmanager"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["--storage.path=/alertmanager"]
