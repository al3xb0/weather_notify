-- AlterEnum
-- PENDING is claimed before a channel send and flipped to SENT/FAILED after,
-- so a redelivery can tell "already delivered" from "still in flight".
ALTER TYPE "NotifStatus" ADD VALUE 'PENDING' BEFORE 'SENT';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "eventId" TEXT;

-- Backfill: the stored payload has always carried the event id.
UPDATE "Notification"
SET "eventId" = "payload"->>'eventId'
WHERE jsonb_typeof("payload") = 'object' AND "payload" ? 'eventId';

-- Duplicate (eventId, channel) pairs in history are exactly what the index
-- below prevents going forward. Keep the oldest row labelled and leave the
-- later copies with a NULL eventId so no delivery history is deleted — NULLs
-- are distinct in a Postgres unique index.
UPDATE "Notification" n
SET "eventId" = NULL
WHERE n."eventId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Notification" o
    WHERE o."eventId" = n."eventId"
      AND o."channel" = n."channel"
      AND (o."createdAt", o."id") < (n."createdAt", n."id")
  );

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventId_channel_key" ON "Notification"("eventId", "channel");

-- AlterTable: triggerId becomes a real foreign key, so it must accept NULL for
-- the SetNull behaviour when a trigger is deleted.
ALTER TABLE "Notification" ALTER COLUMN "triggerId" DROP NOT NULL;

-- Orphans predate the constraint; null them out so the FK can be added.
UPDATE "Notification" n
SET "triggerId" = NULL
WHERE n."triggerId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Trigger" t WHERE t."id" = n."triggerId");

-- CreateIndex
CREATE INDEX "Notification_triggerId_idx" ON "Notification"("triggerId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "Trigger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
