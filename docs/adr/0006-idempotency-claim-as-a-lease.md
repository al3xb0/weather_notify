# 0006 — The claim is a lease, not a flag

## Context

At-least-once delivery is not a feature you enable; it is a property you are
stuck with the moment a broker is involved.

This is not defensive programming against a hypothetical. The failure path
publishes to the retry queue and *then* acks the original ([0005]); a crash
between those two lines leaves the message on both queues, and the second copy
would be delivered again. A user gets the same alert twice.

## Decision

`Notification` carries a unique `(eventId, channel)`. Delivery claims that pair
as `PENDING` **before** calling the channel and settles it to `SENT` or
`FAILED` after. A redelivery that finds an existing `SENT` row is skipped and
counted (`notifier_duplicates_skipped_total`).

The unique index is the arbiter, so two consumers racing on the same
redelivery cannot both win.

**The claim is a lease, not a flag.** `PENDING` on its own cannot tell a
consumer that is inside the channel call right now from one that died mid-send
— and taking the row over in the first case sends the alert twice, which is the
exact thing being prevented. `claimedAt` dates the attempt:

- Taking over is one conditional `UPDATE` that matches only rows nobody holds
  — unclaimed, or claimed longer ago than the lease (60 s, longer than any
  channel call's own timeout).
- A consumer that matches nothing raises a **retryable** error rather than
  sending. By the next attempt the holder has either settled the row — which
  then reads as an ordinary duplicate — or died, and its lease has expired.
- A failed send hands the lease straight back, because the retry that follows
  is the same delivery continuing rather than a second consumer.
- A consumer that dies instead leaves the lease to expire on its own.

A row still `PENDING` with an expired lease is therefore a real signal: a
notifier died mid-send.

## Consequences

- One claim covers one channel, which is the wrong grain for **web push**: it
  fans out to every browser subscription the user registered, and one failing
  endpoint retries the event as a whole. `deliveredTo` records the endpoints an
  attempt actually reached, so a retry re-sends only to the devices still owed
  the alert.
- Replaying a dead-lettered message is safe: one that in fact succeeded before
  is skipped rather than delivered twice.
- The cross-service tests use an in-memory store that enforces the same unique
  constraint as the migration, so the idempotency assertions cannot pass
  vacuously against a fake that simply never collides.

[0005]: 0005-a-queue-per-retry-stage.md
