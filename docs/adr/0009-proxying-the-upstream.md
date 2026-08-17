# 0009 — The browser talks to one origin

## Context

The UI called Open-Meteo directly for two things: city search in the trigger
form, and the forecast on the weather page. It was the shortest path — no
endpoint to write, no cache to manage.

It also put a third party nobody here controls inside the critical path of two
visible features. Their CORS policy, their quota and their downtime became
ours, and the failure landed where only users could see it. The frontend's CSP
had to keep a `*.open-meteo.com` wildcard open to allow it.

## Decision

Both go through `core-api`: `GET /geocode` and `GET /weather`.

- **Geocoding** is cached for 24 hours — city coordinates do not move — and the
  key is normalised for case and surrounding whitespace, so `Berlin`, `berlin`
  and ` berlin ` share one entry instead of spending three upstream calls on
  the same search.
- **Forecasts** are cached for 5 minutes and keyed by the same two-decimal
  rounding the watcher groups triggers by, so two people looking at one city
  cost one call.
- Both routes are authenticated and rate-limited. A proxy to a paid-for
  upstream missing either one is an open proxy, and a test asserts both from
  controller metadata so a route added later without them fails.

**The two failure modes are deliberately different.** A geocoder that is down
answers with an empty list, because the client already renders that as "no
matches" and a broken autocomplete is a worse answer than a quiet one — the log
is what makes it visible on our side. A forecast that is down has no useful
empty answer, so it is a 503 rather than an empty page pretending to be data.

## Consequences

- The CSP dropped its `*.open-meteo.com` wildcard: `connect-src` is now
  `'self'` plus the API origin.
- Response flattening moved server-side with the fetch, so the client keeps the
  types and drops the transport details it carried only because the call lived
  there.
- Two more endpoints, two more caches, and Redis is now on the path of the
  weather page. A Redis outage degrades it to an upstream call per view rather
  than breaking it.
- The upstream's rate limit is now shared across all users of a deployment
  rather than spread across their browsers. The caches are what make that a
  better trade rather than a worse one.
