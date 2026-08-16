# 0002 — One boundary, not full Clean Architecture

## Context

The business rules here are genuinely small: threshold comparisons, an AND/OR
combination, a cooldown, a quiet-hours window, and a two-state machine. Most of
the codebase is CRUD over a handful of rows per user.

Wrapping that in entities, use-case interactors, mappers and repository
interfaces for every module would produce more code than the rules it protects,
and the ceremony would be indistinguishable from the parts that matter.

## Decision

The split is drawn at exactly one line: **`libs/domain` is pure, everything
else may be infrastructure.**

`libs/domain` imports nothing from Nest, Prisma, or any IO package. An eslint
`no-restricted-imports` rule scoped to that directory enforces it. That is the
whole boundary.

Ports exist only where something real crosses them — the upstream weather API,
the broker, and the read models of the two workers — not as a uniform tax on
every service.

That last part is a rule rather than a mood: **the workers reach persistence
through ports; `core-api` does not.** A worker's collaborators are the things
that fail independently, and a delivery path that cannot be exercised without a
database is a delivery path nobody tests properly. The notifier's channels used
to query Prisma directly, which is exactly why its retry and claim behaviour
was asserted against mocked query shapes rather than against behaviour.
`core-api` stays flat because its controllers *are* the database, near enough:
a port there would be a second name for the same CRUD.

## Consequences

- The state machine's full transition matrix — state × cooldown × quiet hours,
  including boundaries — is table-testable with **no mocks at all**. That is
  what extracting the domain bought, and it is the whole return on this
  decision.
- The suppression reason falls out as a value (`cooldown`, `quiet_hours`),
  which becomes a metric label for free and answers the question users actually
  ask: why didn't I get an alert?
- Someone expecting a canonical layered architecture will find `core-api`
  "inconsistent" with the workers. It is inconsistent on purpose, and this
  record is the answer.
- Nothing stops a future module from reaching into infrastructure where a port
  would have been better. The eslint rule guards the domain, not judgement.
