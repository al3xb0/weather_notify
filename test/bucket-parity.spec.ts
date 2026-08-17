import { locationBucket } from '@app/domain';

/**
 * The bucket is computed by TypeScript when a trigger is written and by
 * PL/pgSQL when the column was backfilled, so the two implementations have to
 * agree exactly. A divergence is not cosmetic: two rows for one location would
 * land in different buckets and be fetched twice, and the row's bucket would
 * change under it the next time anyone edited the trigger.
 *
 * These values come from running the migration's function against Postgres.
 * The last two are the halfway cases that caught the original decimal
 * rounding, where JavaScript's toFixed and Postgres' numeric round disagreed.
 */
describe('location bucket parity with the backfill migration', () => {
  it.each([
    [52.52, 13.405, 466],
    [-33.87, 151.21, 97],
    [0, 0, 685],
    [48.13, 11.57, 759],
    [-33.875, 151.215, 936],
    [12.005, -0.001, 511],
  ])('%p,%p lands in bucket %i', (lat, lon, expected) => {
    expect(locationBucket(lat, lon)).toBe(expected);
  });
});
