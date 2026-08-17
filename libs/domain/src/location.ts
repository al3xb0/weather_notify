/**
 * How a coordinate pair becomes a unit of work, and how those units are split
 * across watcher instances.
 *
 * This lives in the domain rather than next to the watcher because two sides
 * have to agree on it: core-api stamps a trigger's bucket when the row is
 * written, and the watcher selects on it. A second copy of the hash would be a
 * silent way for a location to be claimed by nobody.
 */

/**
 * Coordinates are snapped to hundredths — roughly a kilometre, which is well
 * inside what one weather reading covers — and the key is built from those
 * hundredths as integers.
 *
 * Integers rather than `toFixed(2)`, because the backfill migration has to
 * produce the same key in PL/pgSQL and decimal rounding does not survive the
 * trip. `toFixed` rounds the binary double, so 13.405 — stored as
 * 13.40499999999999... — becomes "13.40", while Postgres converts to `numeric`
 * first and rounds half-up to "13.41". Two languages, two buckets, one
 * location. `floor(x * 100 + 0.5)` is one rule applied to the same double on
 * both sides, and it agrees everywhere including the halfway cases.
 */
const LOCATION_SCALE = 100;

function snap(value: number): number {
  return Math.floor(value * LOCATION_SCALE + 0.5);
}

/**
 * How many buckets locations are hashed into, fixed forever.
 *
 * The shard count is deployment configuration and changes; this does not. A
 * bucket is therefore stable enough to store on the row, which is what lets
 * the split be a `WHERE` clause the database can index instead of a filter
 * applied after every instance has read the whole table.
 *
 * 1024 is well above any plausible shard count, so buckets stay evenly spread
 * across shards even when the count does not divide it.
 */
export const LOCATION_BUCKETS = 1024;

/**
 * The key one upstream call covers. Triggers rounded to the same coordinates
 * share a fetch, which is why the watcher groups by this rather than by
 * trigger.
 */
export function locationKey(latitude: number, longitude: number): string {
  return `${snap(latitude)}:${snap(longitude)}`;
}

/**
 * FNV-1a. Chosen for being stable across processes, restarts and languages —
 * the only property that matters here, and the reason the backfill migration
 * can reproduce it in PL/pgSQL.
 */
export function hashLocation(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // `Math.imul`, not `*`. JavaScript multiplies as float64, and the FNV
    // prime pushes the product past 2^53 immediately — which discards the low
    // bits, the exact ones the modulo then reads. Written with `*` this
    // distributed 400 locations across four shards as 360/9/25/6.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The stored bucket for a coordinate pair. */
export function locationBucket(latitude: number, longitude: number): number {
  return hashLocation(locationKey(latitude, longitude)) % LOCATION_BUCKETS;
}

/**
 * Which buckets an instance is responsible for.
 *
 * Enumerated rather than expressed as `bucket % count = index`, because a
 * modulo on a column cannot use an index and the whole point of the bucket is
 * to be selectable. At most `LOCATION_BUCKETS` values, which Postgres handles
 * as an ordinary `IN` list.
 */
export function bucketsForShard(index: number, count: number): number[] {
  const buckets: number[] = [];
  for (let bucket = 0; bucket < LOCATION_BUCKETS; bucket++) {
    if (bucket % count === index) {
      buckets.push(bucket);
    }
  }
  return buckets;
}
