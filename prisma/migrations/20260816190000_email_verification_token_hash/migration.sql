-- The verification token clears the gate on arming alerts, so it is stored as a
-- fingerprint rather than in the clear, like the deep-link token next door.
-- Existing values are dropped rather than hashed in place: hashing them here
-- would leave the plaintext in the WAL, which is most of what this is for.
--
-- Unlike the 15-minute deep link, a verification token lives 24 hours, so links
-- genuinely in flight are invalidated. That is what POST /auth/resend-verification
-- is for, and the gate it clears is soft — the account keeps working meanwhile.
ALTER TABLE "User" DROP COLUMN "emailVerificationToken";
ALTER TABLE "User" ADD COLUMN "emailVerificationTokenHash" TEXT;
UPDATE "User" SET "emailVerificationTokenExpiresAt" = NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_emailVerificationTokenHash_key" ON "User"("emailVerificationTokenHash");
