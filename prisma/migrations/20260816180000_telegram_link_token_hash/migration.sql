-- The deep-link token binds a Telegram chat to an account, so it is stored as a
-- fingerprint rather than in the clear. Existing values cannot be hashed in
-- place (that would invalidate nothing and keep the plaintext in the WAL), and
-- they live for 15 minutes — any link in flight is simply reissued.
ALTER TABLE "User" DROP COLUMN "telegramLinkToken";
ALTER TABLE "User" ADD COLUMN "telegramLinkTokenHash" TEXT;
UPDATE "User" SET "telegramLinkTokenExpiresAt" = NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramLinkTokenHash_key" ON "User"("telegramLinkTokenHash");
