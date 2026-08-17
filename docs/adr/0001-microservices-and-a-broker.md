# 0001 — Three services and a broker

## Context

The system polls a weather API on a schedule, evaluates user-defined
conditions, and delivers alerts over Telegram, email and web push. That is
small enough to be one process, and the load does not need more.

The delivery side is not like the rest of it. Telegram, SMTP and push services
fail on their own schedule, for reasons outside our control, and they fail
slowly — a timeout, not an error. In one process a five-minute SMTP outage
stalls the poll cycle behind it, and a slow channel delays every unrelated
alert queued after it.

## Decision

Three processes — `core-api`, `watcher`, `notifier` — over one database, with
RabbitMQ between the watcher and the notifier. One deployment unit.

This is **failure isolation, not scale**. The broker also buys ordering-free
fan-out: one fired event lands on the channel queues the trigger names, and
each is retried independently.

The alternative inside one process is either sequential delivery — where one
bad channel blocks the rest, which is the problem being solved — or
hand-rolled concurrency with the same retry and persistence problems, solved
worse and with less scrutiny than a broker gets.

## Consequences

**What this costs:**

- A fired event now needs an idempotency claim in the database ([0006]), because
  the transport is at-least-once.
- Every developer needs RabbitMQ running locally, and CI needs it in the smoke
  job.
- The delivery path is asynchronous, so "did my alert send?" is answered by the
  notification history and metrics rather than by an HTTP response.

Both costs are paid once, by the platform, rather than per feature.

**What it does not buy:** independent scaling. The three services share a
database and a deployment; scaling one means scaling the box. The watcher is
additionally single-instance by design (a Redis lock, not sharding), so this
is not a step towards horizontal scale and should not be read as one.

[0006]: 0006-idempotency-claim-as-a-lease.md
