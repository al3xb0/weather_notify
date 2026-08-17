import { LOCATION_BUCKETS } from '@app/domain';
import { shardBuckets, shardFromEnv } from './sharding';

describe('shardFromEnv', () => {
  it('defaults to owning everything', () => {
    expect(shardFromEnv({})).toEqual({ index: 0, count: 1 });
  });

  it('reads the configured coordinates', () => {
    expect(
      shardFromEnv({ WATCHER_SHARD_COUNT: '4', WATCHER_SHARD_INDEX: '2' }),
    ).toEqual({ index: 2, count: 4 });
  });

  it('falls back to the whole set on nonsense rather than to nothing', () => {
    // The schema rejects these at boot; if one ever reaches here, owning
    // everything duplicates work, while owning nothing evaluates no triggers
    // at all and looks like a system with no users.
    expect(shardFromEnv({ WATCHER_SHARD_COUNT: 'many' })).toEqual({
      index: 0,
      count: 1,
    });
  });
});

describe('shardBuckets', () => {
  /**
   * Not the same as listing all of them. An unrestricted query is the cheaper
   * plan, and it is also the one that returns rows written before the column
   * existed — a single-instance deployment must not depend on the backfill.
   */
  it('asks for no restriction at all when there is one instance', () => {
    expect(shardBuckets({ index: 0, count: 1 })).toBeUndefined();
  });

  it('asks for this instance share of the bucket space', () => {
    const buckets = shardBuckets({ index: 1, count: 4 });

    expect(buckets).toHaveLength(LOCATION_BUCKETS / 4);
    expect(buckets?.[0]).toBe(1);
    expect(new Set(buckets).size).toBe(buckets?.length);
  });
});
