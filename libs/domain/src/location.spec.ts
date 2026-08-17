import {
  bucketsForShard,
  hashLocation,
  LOCATION_BUCKETS,
  locationBucket,
  locationKey,
} from './location';

const coordinates = Array.from({ length: 400 }, (_, i) => ({
  latitude: (i % 20) * 3.7 - 35,
  longitude: Math.floor(i / 20) * 9.1 - 80,
}));

/** Which shard, of `count`, ends up polling a location. */
function ownerOf(
  { latitude, longitude }: { latitude: number; longitude: number },
  count: number,
): number[] {
  const bucket = locationBucket(latitude, longitude);
  return Array.from({ length: count }, (_, index) => index).filter((index) =>
    bucketsForShard(index, count).includes(bucket),
  );
}

describe('locationKey', () => {
  it('rounds to two decimals, which is what shares one upstream call', () => {
    expect(locationKey(52.5201, 13.4055)).toBe('52.52:13.41');
    expect(locationKey(52.5199, 13.4051)).toBe('52.52:13.41');
  });

  it('keeps the sign, so hemispheres do not collide', () => {
    expect(locationKey(-33.87, 151.21)).toBe('-33.87:151.21');
    expect(locationKey(-33.87, 151.21)).not.toBe(locationKey(33.87, 151.21));
  });
});

describe('hashLocation', () => {
  it('is a pure function of the string', () => {
    expect(hashLocation('52.52:13.41')).toBe(hashLocation('52.52:13.41'));
    expect(hashLocation('52.52:13.41')).not.toBe(hashLocation('52.52:13.42'));
  });

  it('stays inside unsigned 32-bit range', () => {
    // A negative value would make the modulo negative and match no bucket.
    for (const { latitude, longitude } of coordinates.slice(0, 50)) {
      const hash = hashLocation(locationKey(latitude, longitude));
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  /**
   * The value is stored on the row and reproduced by the backfill migration in
   * PL/pgSQL, so it is a wire format rather than an implementation detail: a
   * change here silently re-assigns every existing trigger. Pinned against a
   * known FNV-1a result rather than against itself.
   */
  it('matches FNV-1a for a known input', () => {
    expect(hashLocation('a')).toBe(0xe40c292c);
    expect(hashLocation('foobar')).toBe(0xbf9cf968);
  });
});

describe('locationBucket', () => {
  it('lands inside the fixed bucket space', () => {
    for (const { latitude, longitude } of coordinates) {
      const bucket = locationBucket(latitude, longitude);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(LOCATION_BUCKETS);
    }
  });

  it('gives coordinates that round together the same bucket', () => {
    expect(locationBucket(52.5201, 13.4055)).toBe(
      locationBucket(52.5199, 13.4051),
    );
  });
});

describe('bucketsForShard', () => {
  it('covers every bucket exactly once across the shards', () => {
    for (const count of [1, 2, 3, 4, 8]) {
      const seen = Array.from({ length: count }, (_, index) =>
        bucketsForShard(index, count),
      ).flat();
      expect(new Set(seen).size).toBe(LOCATION_BUCKETS);
      expect(seen).toHaveLength(LOCATION_BUCKETS);
    }
  });

  it.each([2, 3, 4, 8])(
    'across %i shards, every location has exactly one owner',
    (count) => {
      for (const location of coordinates) {
        // The partition has to be both complete and disjoint: a location owned
        // by nobody is silently never evaluated, and one owned twice is a
        // duplicate upstream call and a duplicate alert.
        expect(ownerOf(location, count)).toHaveLength(1);
      }
    },
  );

  it('splits the set without a wildly lopsided share', () => {
    const count = 4;
    const sizes = Array.from({ length: count }, (_, index) => {
      const buckets = new Set(bucketsForShard(index, count));
      return coordinates.filter(({ latitude, longitude }) =>
        buckets.has(locationBucket(latitude, longitude)),
      ).length;
    });

    // Not a claim about the hash's quality — just that no instance is left
    // doing nothing while another does everything, which would make the
    // horizontal split pointless.
    const expected = coordinates.length / count;
    for (const size of sizes) {
      expect(size).toBeGreaterThan(expected * 0.6);
      expect(size).toBeLessThan(expected * 1.4);
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(coordinates.length);
  });
});
