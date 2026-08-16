-- CreateTable
-- The watcher writes fired events here inside the transaction that moves the
-- trigger to FIRED, and a relay drains them to the broker afterwards.
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "routingKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- A commit retried after a partial failure must not enqueue the same delivery
-- a second time.
CREATE UNIQUE INDEX "OutboxEvent_eventId_routingKey_key" ON "OutboxEvent"("eventId", "routingKey");

-- CreateIndex
-- The relay scans oldest-unpublished-first; published rows sort away from it.
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");
