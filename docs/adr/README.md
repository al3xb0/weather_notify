# Architecture decision records

Decisions worth arguing about, and why they went the way they did. Each one
records what was **given up**, not only what was chosen — a decision without a
cost is usually a decision nobody actually made.

These are the load-bearing ones. If you fork this repository and reverse one,
that is fine; the record is here so you know what you are trading away.

| # | Decision | In one line |
|---|----------|-------------|
| [0001](0001-microservices-and-a-broker.md) | Three services and a broker | Failure isolation, not scale |
| [0002](0002-domain-purity-not-clean-architecture.md) | One boundary, not full Clean Architecture | `libs/domain` imports nothing; everything else may be infrastructure |
| [0003](0003-persistence-depends-on-the-domain.md) | `libs/database` knows the domain, never the reverse | A compile-time assertion where the two vocabularies meet |
| [0004](0004-cqrs-in-one-module.md) | CQRS in `triggers` only | The boundary is the point |
| [0005](0005-a-queue-per-retry-stage.md) | One retry queue per delay | A shared queue head-of-line blocks |
| [0006](0006-idempotency-claim-as-a-lease.md) | The claim is a lease, not a flag | `PENDING` alone cannot tell a live consumer from a dead one |
| [0007](0007-transactional-outbox.md) | The watcher never publishes directly | A crash between publish and record fires a second, unrecognisable event |
| [0008](0008-openapi-as-the-client-contract.md) | A committed OpenAPI document | The same guarantee as a shared package, with no registry |
| [0009](0009-proxying-the-upstream.md) | The browser talks to one origin | A third party's uptime should not be a visible feature's uptime |
| [0010](0010-sharding-the-watcher.md) | The watcher shards by location | Instances agree without talking to each other |
| [0011](0011-denying-tokens-for-a-deleted-account.md) | A deny marker for deleted accounts | A stateless token cannot know its account is gone |

## Format

Context (what forced a choice), Decision (what was chosen), Consequences (what
it costs). No status field: everything here is in force, and a reversed
decision would be a new record rather than an edited one.
