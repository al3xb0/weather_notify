# Using this as a template

This started as a weather alerting system, but almost none of the machinery is
about weather. The parts worth reusing — the state machine that stops a
sustained condition from alerting every cycle, the transactional outbox, the
idempotency lease, the retry ladder with a real dead-letter queue — apply to
**any "watch a signal, alert when it crosses a line" product**: price
monitoring, uptime checks, stock levels, sensor thresholds, API quotas.

Weather is the signal, not the architecture. This document is the shortest path
from this repository to yours.

## What you keep for free

Everything in this list is domain-agnostic and needs no changes:

- **Delivery** — Telegram, email and web push behind a registry, with staged
  retries, a dead-letter queue and per-attempt idempotency ([ADR 0005], [0006])
- **The outbox** — a signal that fired is never lost and never fires twice
  under a new id ([ADR 0007])
- **Auth** — registration, login, rotating refresh tokens with reuse detection,
  email verification, password reset, account deletion, and a deny marker so a
  deleted account's stateless tokens stop working immediately ([ADR 0011])
- **Anti-spam** — the `ARMED` → `FIRED` state machine, per-trigger cooldown,
  hysteresis, per-user timezone-aware quiet hours
- **Operations** — health/readiness, Prometheus metrics with alert rules that
  route through Alertmanager, Grafana dashboards, scheduled database backups
  with a tested restore, and horizontal scale for the poller via sharding
- **The contract** — a committed OpenAPI document and generated client types,
  checked at both ends ([ADR 0008])

## What you change

Four files decide what the system watches. In dependency order:

### 1. The vocabulary — `libs/domain/src/enums.ts`

`Metric` is the list of things a condition can be written about. Replace the
weather metrics with yours:

```ts
export const Metric = {
  PRICE: 'PRICE',
  STOCK_LEVEL: 'STOCK_LEVEL',
  // …
} as const;
```

`Operator`, `ConditionLogic`, `TriggerState`, `Channel` and `NotifStatus` stay
as they are unless you need a new comparison.

### 2. The schema — `prisma/schema.prisma`

Mirror the same enum values in the Prisma `Metric` enum and run
`npm run db:migrate`. A mismatch is a **compile error**, not a runtime
surprise — `libs/database/src/domain-enums.guard.ts` asserts the two
vocabularies are mutually assignable ([ADR 0003]).

`Trigger` also carries `city`, `latitude` and `longitude`, which are how a
weather trigger names its subject. Yours might be a product URL or a sensor id
— rename them here and follow the compiler.

### 3. The reading — `libs/domain/src/weather/condition-evaluator.ts`

`WeatherSnapshot` is the shape of one observation, and the evaluator maps a
`Metric` to a field on it. Rename the type to whatever you are observing and
replace the field mapping. Everything around it — AND/OR combination, the
per-condition results that become the alert body — is untouched.

This file is pure. Its tests need no mocks, which is the point of [ADR 0002].

### 4. The source — `apps/watcher/src/ports/weather-provider.port.ts`

```ts
export interface WeatherProvider {
  getSnapshot(latitude: number, longitude: number): Promise<WeatherSnapshot>;
}
```

One method. Rename it, change the arguments to whatever identifies your
subject, and write an implementation next to `open-meteo.provider.ts`. Use that
one as the model: it caches in Redis, times out, retries once, and counts cache
hits and fetch failures as metrics.

Bind your implementation to the `WEATHER_PROVIDER` token in
`apps/watcher/src/watcher.module.ts` and the cycle picks it up unchanged.

## Adding a delivery channel

Independent of the above, and genuinely one array entry. Implement
`NotificationChannel` (see `apps/notifier/src/channels/email.channel.ts`),
declare its `channel` key, and append the class to `CHANNEL_IMPLEMENTATIONS` in
`channels/channel.registry.ts`. The queue topology is derived from the
registry, so the retry and dead-letter queues for the new channel are declared
on the next start.

The one thing to get right is **error classification**: throw
`PermanentNotificationError` when retrying cannot help (a bad address, missing
credentials) and anything else when it can. The retry ladder is only correct if
channels get this right, which is why `channels.spec.ts` tests exactly that.

## Housekeeping for a fork

- **`.env.example` ships development defaults.** Read `SECURITY.md` before
  exposing a deployment — at minimum change the three passwords, both JWT
  secrets, `CORS_ORIGIN` and `TRUST_PROXY`.
- **The UI's CI checks out this repository** for `openapi.json`. Point it at
  your fork with the `API_REPO` repository variable (Settings → Secrets and
  variables → Actions → Variables) rather than editing the workflow.
- **Rename the product.** `weather_notify` appears in `package.json`, the
  Compose container names (`wn_*`), the database name and the queue prefix
  `notifications.*`.
- **The Grafana dashboard** in `ops/grafana/dashboards/` refers to
  `watcher_*` metric names. Rename them together with the watcher's metrics or
  the panels go blank.

## What is deliberately not here

So you can decide whether to build it rather than discover it missing:

- **No billing, no organisations.** Users are individuals, and limits are
  constants in `apps/core-api/src/meta/limits.ts` served over `GET /meta`. This
  is the largest gap between the project and a commercial product.
- **No rebalancing for the watcher's shards.** Changing the shard count
  reassigns most locations at once, so the instances have to restart together
  ([ADR 0010]). Consistent hashing is what removes that.
- **One alerting channel.** Alertmanager routes to a webhook or to email — and
  email is the same path the notifier depends on, so an SMTP outage swallows
  the alert about itself. A second, independent channel is the standard answer.
- **No infrastructure-as-code, no zero-downtime deploy.** `docker compose up -d`
  on one machine; recreating a container is a short outage.
- **One deployment, one database.** Three services, but not independently
  scalable — see [ADR 0001] for why the split exists at all.

The frontend adds a light theme and English/Russian, both without a library —
see its README if you want the shape of either.

[ADR 0001]: adr/0001-microservices-and-a-broker.md
[ADR 0002]: adr/0002-domain-purity-not-clean-architecture.md
[ADR 0003]: adr/0003-persistence-depends-on-the-domain.md
[ADR 0005]: adr/0005-a-queue-per-retry-stage.md
[0006]: adr/0006-idempotency-claim-as-a-lease.md
[ADR 0007]: adr/0007-transactional-outbox.md
[ADR 0008]: adr/0008-openapi-as-the-client-contract.md
[ADR 0010]: adr/0010-sharding-the-watcher.md
[ADR 0011]: adr/0011-denying-tokens-for-a-deleted-account.md
