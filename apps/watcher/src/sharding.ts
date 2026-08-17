/**
 * Splitting the trigger set across watcher instances.
 *
 * Triggers are already grouped by rounded location, because that is the unit
 * one upstream call covers. That grouping is also the natural unit of work to
 * divide: assigning a whole location to one instance keeps the deduplication
 * intact, where dividing by trigger would have two instances fetching the same
 * coordinates.
 *
 * The assignment is a pure function of the location key, so instances need no
 * coordination to agree on it — no leader, no rebalancing protocol, no shared
 * state beyond the count they were each configured with.
 */
export interface ShardConfig {
  index: number;
  count: number;
}

/**
 * FNV-1a. Chosen for being stable across processes and restarts, which is the
 * only property that matters here — `String.prototype.hashCode` does not exist
 * and object iteration order would not survive a redeploy.
 */
export function hashLocation(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // `Math.imul`, not `*`. JavaScript multiplies as float64, and the FNV
    // prime pushes the product past 2^53 immediately — which discards the low
    // bits, the exact ones `% count` then reads. Written with `*` this
    // distributed 400 locations across four shards as 360/9/25/6.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Whether this instance is the one responsible for a location. */
export function ownsLocation(
  key: string,
  { index, count }: ShardConfig,
): boolean {
  // The single-instance case is the default and must not depend on the hash
  // being well distributed.
  if (count <= 1) {
    return true;
  }
  return hashLocation(key) % count === index;
}

/**
 * Read the shard coordinates from the environment. Validated at boot by
 * `watcherEnvSchema`, so an out-of-range index fails fast rather than becoming
 * an instance that silently matches nothing.
 */
export function shardFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ShardConfig {
  const count = Number(env.WATCHER_SHARD_COUNT ?? 1);
  const index = Number(env.WATCHER_SHARD_INDEX ?? 0);
  return {
    count: Number.isFinite(count) && count > 0 ? count : 1,
    index: Number.isFinite(index) && index >= 0 ? index : 0,
  };
}
