-- Give every trigger the bucket the watcher selects on, so the shard split is
-- a predicate the database serves rather than a filter each instance applies
-- after reading the whole table.

ALTER TABLE "Trigger" ADD COLUMN "locationBucket" INTEGER NOT NULL DEFAULT 0;

-- FNV-1a over the rounded coordinate key, reproducing `locationBucket` in
-- @app/domain. Written here rather than backfilled from a script because the
-- column is not nullable and a row with the wrong bucket is a location no
-- instance polls — the migration is the only place that runs before any
-- watcher does.
CREATE OR REPLACE FUNCTION pg_temp.fnv1a_location(lat DOUBLE PRECISION, lon DOUBLE PRECISION)
RETURNS BIGINT AS $$
DECLARE
  -- to_char with FM and a fixed scale matches Number.prototype.toFixed(2):
  -- always two decimals, no padding, a leading minus where there is one.
  key TEXT := to_char(lat::numeric, 'FM9999999990.00') || ':' ||
              to_char(lon::numeric, 'FM9999999990.00');
  hash BIGINT := 2166136261;
  i INTEGER;
BEGIN
  FOR i IN 1..length(key) LOOP
    hash := hash # ascii(substr(key, i, 1));
    -- Truncate to 32 bits after every multiply, exactly as `Math.imul` does.
    hash := (hash * 16777619) & 4294967295;
  END LOOP;
  RETURN hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "Trigger"
SET "locationBucket" = (pg_temp.fnv1a_location("latitude", "longitude") % 1024)::INTEGER;

-- The index the cycle scan uses: active rows, restricted to this instance's
-- buckets. It replaces the coordinate index, which only ever served a
-- predicate on `isActive` because nothing queried by latitude or longitude.
DROP INDEX IF EXISTS "Trigger_isActive_latitude_longitude_idx";
CREATE INDEX "Trigger_isActive_locationBucket_idx" ON "Trigger" ("isActive", "locationBucket");
