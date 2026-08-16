# 0004 — CQRS in `triggers` only

## Context

`@nestjs/cqrs` is available and the pattern is conventional in NestJS
codebases of this shape. Applying it everywhere is the default many projects
reach for.

Most modules here do not earn it. Users, pinned cities, notification history
and the admin surface are CRUD over a handful of rows per user: the write path
and the read path share the same rules, so splitting them adds a bus, two extra
files per operation, and a worse stack trace in exchange for nothing.

## Decision

`triggers` goes through the command/query bus. Nothing else does.

Triggers are the only place where the write side carries rules the read side
does not share:

- an email-verification gate on arming alerts,
- a per-user trigger limit,
- a test-send cooldown.

Separating them there buys something real. Elsewhere it would be ceremony.

**The boundary is the point.** A codebase where every module has commands and
queries says nothing about the code; one where a single module does says the
split was a decision.

## Consequences

- A reader has to notice that the inconsistency is deliberate. This record is
  that notice.
- Moving a rule from a trigger command into, say, users means either dropping
  to a service call or extending the bus to a second module — the decision has
  to be made again rather than followed by default.
- The command handlers are where the interesting `triggers` tests live
  (`create-trigger.command.spec.ts`, `send-test-notification.command.spec.ts`),
  which is why those are the parts of `core-api` with real coverage.
