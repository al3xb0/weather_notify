-- CreateIndex
-- The retention sweep deletes by age across all users, which the existing
-- ("userId", "createdAt") index cannot serve — its leading column is the user.
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
