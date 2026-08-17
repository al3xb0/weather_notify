# 0007 — The watcher never publishes directly

## Context

The idempotency claim ([0006]) keys on `eventId`, so it only recognises a
duplicate of the *same* event.

Publishing first and recording the firing second defeats it. A crash in
between leaves the trigger `ARMED`, and the next cycle fires it again under a
fresh `eventId` — a genuinely different event as far as the consumer can tell,
and a second alert it has no way to recognise as a repeat.

Recording first and publishing second has the mirror problem: the trigger is
`FIRED`, nothing was published, and the alert is silently lost.

## Decision

The watcher does not publish at all.

`commitFire` writes the condition observations, the trigger's new state and one
`OutboxEvent` row per channel **in a single transaction**. `OutboxRelayService`
hands those rows to the broker afterwards, marking each only once the broker
has accepted it.

The cycle nudges the relay immediately, so latency is unchanged. A cron pass
every 30 seconds is what makes delivery guaranteed rather than best-effort,
covering a broker outage or a process that dies mid-publish.

A pass stops at its first failure, so events reach the exchange in the order
they fired. A row that was published but not yet marked is simply redelivered
— which lands back on the `(eventId, channel)` claim.

## Consequences

- Relayed rows are swept after 24 hours, so the table stays bounded.
- `watcher_outbox_pending` is the gauge to alert on: a growing backlog means
  the relay is not keeping up, and alerts are being recorded but not delivered.
  It counts the staged rows **directly** rather than measuring the batch just
  drained — a batch is capped at `OUTBOX_BATCH_SIZE`, so a gauge derived from
  it would sit at exactly that number however far behind the relay fell.
- There is one more table and one more background job than a direct publish
  would need.
- The watcher's tests can assert what was committed without a broker at all,
  because publishing is no longer part of the firing path.

[0006]: 0006-idempotency-claim-as-a-lease.md
