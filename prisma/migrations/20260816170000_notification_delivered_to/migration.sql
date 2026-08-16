-- AlterTable
-- Web push fans one claim out to every browser subscription the user has. A
-- retry caused by one of them failing used to re-notify all of them; the ones
-- that already landed are recorded here so the retry skips them.
ALTER TABLE "Notification" ADD COLUMN "deliveredTo" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
