-- A password reset takes the account over outright, so the token is stored as a
-- fingerprint rather than in the clear — the same reasoning as the verification
-- and deep-link tokens next door, with more at stake if the table leaks.
ALTER TABLE "User" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_passwordResetTokenHash_key" ON "User"("passwordResetTokenHash");
