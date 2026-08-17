# 0005 — One retry queue per delay

## Context

Delivery fails transiently all the time: an SMTP timeout, a Telegram 429, a
push endpoint that is briefly unreachable. Those should be retried with
escalating backoff — here 5 s, 30 s, 5 min (`NOTIFIER_RETRY_DELAYS_MS`).

The obvious implementation is one retry queue with a per-message TTL. It does
not work.

## Decision

Three retry queues **per channel**, one per delay stage, each dead-lettering
back to the main queue after its own TTL:

```
notifications.email            ← consumed
notifications.email.retry.1    TTL 5s    ─┐
notifications.email.retry.2    TTL 30s   ─┼─→ dead-letters back to notifications.email
notifications.email.retry.3    TTL 5m    ─┘
notifications.email.dead                   ← terminal, nothing consumes it
```

**Why not per-message TTLs?** A RabbitMQ queue only expires messages from its
head, in publish order. One shared retry queue holding mixed delays means a
message with a five-minute TTL sitting at the front holds back every
five-second one behind it — the classic head-of-line block. Separate queues
make each delay independent.

The attempt count travels in an explicit `x-attempts` header rather than being
read from `x-death`, which is unreliable across repeated main↔retry bounces.

## Consequences

- The topology is `channels × (1 + stages + 1)` queues — fifteen at the current
  three channels and three stages. The smoke job asserts all of them exist,
  because a wrong queue argument is invisible to any test that fakes the
  broker.
- Adding a retry stage is a config change that changes the topology, so it
  takes a restart to declare the new queues.
- A failed delivery is republished onto the next stage and the original is
  acked. A crash between those two lines leaves the message on both queues —
  which is precisely what the idempotency claim ([0006]) exists to absorb.
- Everything terminal is parked in `notifications.<channel>.dead` with an
  `x-dead-reason` header (`unparseable`, `permanent`, `attempts_exhausted`).
  Nothing consumes those queues; messages sit there with their payload intact.
  To replay, publish the body back onto the exchange with the channel's
  `.fired` routing key and no `x-attempts` header — the claim makes that safe.

[0006]: 0006-idempotency-claim-as-a-lease.md
