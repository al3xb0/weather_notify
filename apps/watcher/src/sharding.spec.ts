import { hashLocation, ownsLocation, shardFromEnv } from './sharding';

const locations = Array.from({ length: 400 }, (_, i) => {
  const lat = (i % 20) * 3.7 - 35;
  const lon = Math.floor(i / 20) * 9.1 - 80;
  return `${lat.toFixed(2)}:${lon.toFixed(2)}`;
});

describe('sharding', () => {
  describe('ownsLocation', () => {
    it('gives every location to a single instance', () => {
      const owned = locations.filter((key) =>
        ownsLocation(key, { index: 0, count: 1 }),
      );
      expect(owned).toHaveLength(locations.length);
    });

    it.each([2, 3, 4, 8])(
      'across %i shards, every location has exactly one owner',
      (count) => {
        for (const key of locations) {
          const owners = Array.from({ length: count }, (_, index) =>
            ownsLocation(key, { index, count }),
          ).filter(Boolean);
          // The partition has to be both complete and disjoint: a location
          // owned by nobody is silently never evaluated, and one owned twice
          // is a duplicate upstream call and a duplicate alert.
          expect(owners).toHaveLength(1);
        }
      },
    );

    it('splits the set without a wildly lopsided share', () => {
      const count = 4;
      const sizes = Array.from(
        { length: count },
        (_, index) =>
          locations.filter((key) => ownsLocation(key, { index, count })).length,
      );

      // Not a claim about the hash's quality — just that no instance is left
      // doing nothing while another does everything, which would make the
      // horizontal split pointless.
      const expected = locations.length / count;
      for (const size of sizes) {
        expect(size).toBeGreaterThan(expected * 0.6);
        expect(size).toBeLessThan(expected * 1.4);
      }
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(locations.length);
    });

    it('is stable across calls, so a location does not migrate mid-cycle', () => {
      const first = locations.map((key) =>
        ownsLocation(key, { index: 1, count: 3 }),
      );
      const second = locations.map((key) =>
        ownsLocation(key, { index: 1, count: 3 }),
      );
      expect(second).toEqual(first);
    });
  });

  describe('hashLocation', () => {
    it('is a pure function of the string', () => {
      expect(hashLocation('52.52:13.41')).toBe(hashLocation('52.52:13.41'));
      expect(hashLocation('52.52:13.41')).not.toBe(hashLocation('52.52:13.42'));
    });

    it('stays inside unsigned 32-bit range', () => {
      // A negative value would make the modulo negative and match no shard.
      for (const key of locations.slice(0, 50)) {
        const hash = hashLocation(key);
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(hash).toBeLessThanOrEqual(0xffffffff);
      }
    });
  });

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
});
