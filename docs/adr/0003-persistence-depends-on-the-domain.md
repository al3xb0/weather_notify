# 0003 — `libs/database` knows the domain, never the reverse

## Context

The domain declares the vocabulary the system is defined in terms of: `Metric`,
`Operator`, `ConditionLogic`, `TriggerState`, `Channel`, `NotifStatus`. Prisma
generates its own copies of the same enums from `schema.prisma`.

Two copies of one vocabulary drift. The usual fix is to have the domain import
the ORM's generated enums — which would make the pure module depend on the
database, undoing [0002].

## Decision

The domain declares the enums. `libs/database` asserts, at compile time, that
the two vocabularies are mutually assignable:

```ts
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const DOMAIN_ENUMS_MATCH_PRISMA: [
  AssertEqual<Metric, PrismaMetric>,
  /* … one per enum … */
] = [true, /* … */];
```

Adding a value on one side alone fails the build **here**, where the two
vocabularies meet, rather than at runtime in whichever service first
encounters the unknown value.

The arrow points from persistence to the domain because that is the direction
the dependency should run: the schema serves the model, not the other way
round.

## Consequences

- A schema change that adds an enum value is a compile error until the domain
  agrees, and vice versa. The failure names the file where the mismatch lives.
- `libs/database` gains a file that exists only to fail. It has no runtime
  behaviour and is exported so nothing tree-shakes it away.
- The assertion covers the *set* of values, not their meaning. Renaming
  `TEMPERATURE` on both sides simultaneously compiles fine and would still be a
  migration problem.

[0002]: 0002-domain-purity-not-clean-architecture.md
