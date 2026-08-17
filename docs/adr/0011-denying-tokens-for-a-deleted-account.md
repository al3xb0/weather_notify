# 0011 — Denying tokens for a deleted account

## Context

Access tokens are stateless and short-lived. Nothing is consulted to accept
one, which is what makes them cheap: no database round-trip per request, and
the role rides along so guards can authorize without one either.

That is fine until the account behind a live token stops existing. Adding
self-service deletion made it an ordinary path rather than an admin edge case,
and for up to fifteen minutes afterwards every token already issued still
authenticated. The requests they made reached foreign keys that no longer
resolved: `POST /pinned-cities`, `PATCH /users/me`, the Telegram link and the
push subscription all answered **500** rather than "you are signed out", and
`POST /triggers` answered 403 "please verify your email" — because
`user?.emailVerified` is false for a user that does not exist, which is a
misleading way to say the account is gone.

The tab that did the deleting never saw this. A second tab or an API client
did.

## Decision

Deletion writes a deny marker keyed by user id, with the access token's own
TTL, and `JwtAuthGuard` checks it after Passport has verified the token.

The TTL is the point: after it the token has expired anyway, so the key is
never long-lived and the store never grows.

The same marker covers two more cases:

- **Admin deletion** — the victim's tokens are denied exactly as in
  self-deletion.
- **Demotion** — the role is signed into the token, so stripping someone's
  admin role was advisory until it expired. Denying the outstanding tokens
  forces the next request through refresh, which re-reads the role. A write
  that does not change the role leaves sessions alone; signing everyone out
  over a verification checkbox would be a surprising cost.

## Consequences

- One Redis lookup per authenticated request. It is a single `EXISTS` against
  a key that is usually absent.
- **The lookup fails open.** An unreachable Redis answers "not revoked" rather
  than rejecting every authenticated request in the system. The window that
  leaves is the same one that existed before this mechanism, so an outage costs
  the improvement rather than the API.
- This is not a general token revocation list. It denies *all* of a user's
  tokens, has no per-token granularity, and is not a step toward stateful
  sessions — the moment it needs to answer "which token" it should be replaced
  by something designed for that.
- `parseDurationMs` moved out of `AuthService`: the marker's TTL and the
  lifetime of the token it denies must be parsed from the same value, and two
  copies could disagree enough to let a token outlive its own revocation.
