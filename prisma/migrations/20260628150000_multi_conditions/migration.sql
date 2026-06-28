-- CreateEnum
CREATE TYPE "ConditionLogic" AS ENUM ('AND', 'OR');

-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "conditionLogic" "ConditionLogic" NOT NULL DEFAULT 'AND';

-- CreateTable
CREATE TABLE "TriggerCondition" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "metric" "Metric" NOT NULL,
    "operator" "Operator" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "lastObservedValue" DOUBLE PRECISION,
    "lastMatched" BOOLEAN,

    CONSTRAINT "TriggerCondition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriggerCondition_triggerId_idx" ON "TriggerCondition"("triggerId");

-- AddForeignKey
ALTER TABLE "TriggerCondition" ADD CONSTRAINT "TriggerCondition_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "Trigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: copy each trigger's single scalar condition into the new relation.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO "TriggerCondition" ("id", "triggerId", "metric", "operator", "threshold", "order", "lastObservedValue", "lastMatched")
SELECT gen_random_uuid()::text, "id", "metric", "operator", "threshold", 0, "lastObservedValue", "lastMatched"
FROM "Trigger";

-- DropColumn (only after the data has been copied above)
ALTER TABLE "Trigger" DROP COLUMN "lastMatched",
DROP COLUMN "lastObservedValue",
DROP COLUMN "metric",
DROP COLUMN "operator",
DROP COLUMN "threshold";
