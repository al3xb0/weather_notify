# 0010 — Sharding the watcher by location

## Context

The watcher polls one location at a time and evaluates every trigger at that
location. A Redis lock kept a second instance from running concurrently, which
made the service safe but single-instance: a second copy idled rather than
sharing the work, and the only way to go faster was a bigger box.

The trigger set is already grouped by rounded location, because that grouping
is what one upstream call covers.

## Decision

An instance owns a location when `hash(location) % count == index`, configured
per replica with `WATCHER_SHARD_COUNT` and `WATCHER_SHARD_INDEX`.

The assignment is a pure function of the location key. No leader election, no
rebalancing protocol, no shared state beyond the count each instance was given
— two instances that never talk to each other still agree on who owns what.

**Whole locations, never individual triggers.** Splitting a location would have
two instances fetching the same coordinates, undoing the deduplication the
grouping exists for.

The lock stays, one key per shard. Different shards run concurrently, which is
the point; two instances configured with the *same* shard still cannot overlap,
which is what a redeploy briefly produces. An unsharded deployment keeps the
original key and behaves exactly as before.

Out-of-range coordinates are rejected at boot. An index past the count matches
no locations at all, and an instance that silently evaluates nothing looks
exactly like a system with no triggers.

## Consequences

- **Rebalancing is not solved.** Changing the count reassigns most locations at
  once, so a rolling change has a window where a location is owned twice or not
  at all. Restarting the watchers together is the honest answer at this size;
  consistent hashing is what removes it.
- The hash must be a real 32-bit hash. Written as `hash * PRIME` the FNV step
  overflows float64 on the first character and discards the low bits — the ones
  `% count` reads. That split 400 locations across four shards as 360/9/25/6,
  which the distribution test caught before it shipped. `Math.imul` gives
  102/97/98/103.
- Each shard polls fewer locations, so `watcher_cycle_duration_seconds` drops
  and the alert threshold on it now means "this shard", not "the system".
- The outbox relay is unchanged: rows are claimed and marked per row, so
  several relays are safe without further coordination.
