# 0008 — A committed OpenAPI document

## Context

The API and the UI live in separate repositories. Something has to keep the
client's idea of the API in step with the API.

A shared npm package of types is the usual answer, and it needs a registry,
versioning and synchronised releases across two repositories for what is
fundamentally a one-directional dependency: the UI follows the API, never the
other way round.

## Decision

`openapi.json` is generated from the controllers and **committed**.

```bash
npm run openapi         # regenerate
npm run openapi:check   # regenerate and fail on a diff (runs in CI)
```

The frontend generates its types from that file with `openapi-typescript`, and
its own CI fails if the committed types drift from the document. So the chain
is checked at both ends:

- API CI: controllers → `openapi.json` (a route change that is not reflected
  fails here)
- UI CI: `openapi.json` → `src/lib/api-types.ts` (a DTO change that the client
  has not picked up fails here)

Without the second check, `tsc` on the UI only ever verifies the types against
themselves, so a stale client stays green.

The dump runs Nest in **preview mode**, which builds the module graph and route
metadata without instantiating providers — so it needs no Postgres, Redis or
RabbitMQ and is reproducible anywhere, including a clean CI runner.

`GET /meta` complements this at runtime: it serves the limits the API enforces
(trigger count, conditions per trigger, cooldown bounds, test-send cooldown) so
clients can disable a control instead of duplicating the numbers. They were
duplicated before and had drifted — the dashboard advertised twenty triggers
against a server limit of ten, so the button stayed enabled and the API
answered 400.

## Consequences

- **Every route needs an explicit response DTO.** Without one the document's
  response schema is empty and there is nothing to generate from. This is the
  most common way to fail `openapi:check`.
- A generated file is committed, so it appears in diffs. That is the point: a
  contract change is visible in review.
- The UI's CI checks out the API repository (sparse, document only). A fork
  points that at its own repository with the `API_REPO` variable.
- Nothing enforces that a *deployed* API matches the document a *deployed* UI
  was built against. This catches drift in source, not in production.
