-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "lastEvaluatedAt" TIMESTAMP(3),
ADD COLUMN     "lastMatched" BOOLEAN,
ADD COLUMN     "lastObservedValue" DOUBLE PRECISION;
