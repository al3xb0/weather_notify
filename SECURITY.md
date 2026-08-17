# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting
(**Security → Report a vulnerability**) or email <alexejkonyshev@gmail.com>.

This is a personal project, not a funded product: expect an acknowledgement
within a few days rather than within hours, and no bounty. Reports are still
genuinely welcome.

## Scope

This repository is a reference implementation people are meant to fork and
deploy. A weakness in the code that a fork would inherit is in scope even if
the author's own deployment is not affected — for example a default that is
unsafe, a token stored in a recoverable form, or a route missing its guard.

Out of scope: findings that require an attacker to already control the server,
the database or the operator's machine, and anything about a deployment of this
software that is not the upstream repository.

## What the code already assumes

Reports that contradict one of these are especially useful, since these are
load-bearing:

- Access tokens are short-lived and held **in memory** by the browser; the
  refresh token lives in an `httpOnly`, path-scoped cookie and is stored
  server-side only as a SHA-256 fingerprint. Replaying a rotated refresh token
  revokes the user's whole token family.
- Every emailed or deep-linked token — email verification, Telegram binding,
  password reset — is stored as a fingerprint, never in the clear. A database
  dump must not yield a usable link.
- Passwords are bcrypt at cost 12, and both registration and reset cap the
  input at 72 bytes because bcrypt silently ignores anything past it.
- `POST /auth/forgot-password` answers identically for known and unknown
  addresses. Any difference an attacker can observe is an enumeration oracle
  and is a bug.
- The Open-Meteo proxy routes (`/geocode`, `/weather`) are authenticated and
  rate-limited. Without both they are an open proxy.
- Secrets are validated at boot: under 32 characters or left as a placeholder
  is a startup failure, not a warning.

## Deploying a fork safely

`.env.example` ships development defaults. Before exposing a deployment:
change `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD` and `GRAFANA_PASSWORD`, set
both JWT secrets to distinct random values of at least 32 characters, set
`CORS_ORIGIN` to your own origins, and set `TRUST_PROXY` to the number of
proxies actually in front of the API — trusting more hops than exist lets a
client forge its own IP through `X-Forwarded-For` and walk around the rate
limiter.
