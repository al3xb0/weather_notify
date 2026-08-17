import { bucketsForShard } from '@app/domain';

/**
 * Reading this instance's slice of the trigger set from the environment.
 *
 * The assignment itself lives in `@app/domain` alongside the hash core-api
 * stamps rows with, because two services have to agree on it and a second copy
 * would be a silent way for a location to be claimed by nobody. What is left
 * here is the deployment half: which shard this process was configured as.
 */
export interface ShardConfig {
  index: number;
  count: number;
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

/**
 * The buckets this instance queries for, or `undefined` for "all of them".
 *
 * The single-instance case is the default and answers `undefined` rather than
 * every bucket: an unrestricted query is both the cheaper plan and the one
 * that still returns rows written before the buckets existed.
 */
export function shardBuckets({
  index,
  count,
}: ShardConfig): number[] | undefined {
  return count <= 1 ? undefined : bucketsForShard(index, count);
}
