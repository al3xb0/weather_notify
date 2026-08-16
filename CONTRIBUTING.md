# Contributing

Thanks for looking. This is primarily a reference implementation, so the bar
for a change is that it makes the system clearer or more correct — not that it
adds a feature.

## Getting a working checkout

```bash
cp .env.example .env          # set JWT secrets (≥32 chars)
docker compose up -d postgres redis rabbitmq
npm install                   # runs `prisma generate` for you
npm run db:migrate
npm test
```

The generated Prisma client is not committed. `postinstall` builds it on a
fresh install and a `post-merge` hook rebuilds it when a pull brings a schema
change — if `tsc` ever complains about a column that plainly exists, run
`npm run db:generate`.

## What CI checks

Everything below runs on every pull request, so run what you can locally first:

| Step | Command |
|------|---------|
| Lint (type-aware) | `npm run lint` |
| Types | `npx tsc -p tsconfig.json --noEmit` |
| Contract freshness | `npm run openapi:check` |
| Unit + cross-service | `npm test` |
| E2E against Postgres | `npm run test:e2e` |
| Build | `npm run build:all` |

A separate smoke job boots the real Compose stack and asserts readiness, the
queue topology, a backup-and-restore round trip and that Prometheus is
scraping. It needs Docker, so it is usually easier to let CI run it.

## House rules

- **`libs/domain` imports nothing.** No Nest, no Prisma, no IO. An eslint rule
  enforces it; that boundary is the one architectural constraint in the
  codebase and the reason the state machine is testable without mocks.
- **Comments explain why, in English.** A comment restating what the line does
  is noise. A comment saying which failure the line prevents is the point.
- **Every route needs an explicit response DTO.** Without one the generated
  OpenAPI document has an empty response schema and the frontend has nothing to
  generate types from. `npm run openapi:check` will catch you.
- **No `userId` or `triggerId` in metric labels.** Every label combination is a
  time series held in memory; a per-user label grows without bound. Identity
  belongs in logs.
- **New behaviour comes with the test that would have caught its absence.** The
  coverage gate is set just under the current numbers, so it ratchets — a drop
  fails the build.

## Commits

Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). The body is
where the reasoning goes: what was wrong before, and why this is the fix rather
than another one. A one-line commit for a subtle change is a change nobody can
review later.

## Architecture decisions

Before proposing a structural change, read [docs/adr/](docs/adr/) — the
decisions there record what was given up, not only what was chosen. If your
change reverses one, that is fine, but say which one and what changed about the
trade-off.
