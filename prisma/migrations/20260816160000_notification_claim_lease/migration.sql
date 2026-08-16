-- AlterTable
-- A claim becomes a lease: the timestamp says when the current attempt took the
-- row, so a redelivery can tell "another consumer is sending right now" from
-- "a consumer died mid-send and left this behind".
ALTER TABLE "Notification" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Rows written before the lease existed are, by definition, not in flight —
-- nothing is holding them. Date them at creation so the sweep treats them as
-- expired leases rather than as fresh claims no one may take over.
UPDATE "Notification" SET "claimedAt" = "createdAt" WHERE "status" <> 'SENT';
