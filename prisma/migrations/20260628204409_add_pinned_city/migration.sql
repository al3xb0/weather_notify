-- CreateTable
CREATE TABLE "PinnedCity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "admin1" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedCity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinnedCity_userId_idx" ON "PinnedCity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PinnedCity_userId_latitude_longitude_key" ON "PinnedCity"("userId", "latitude", "longitude");

-- AddForeignKey
ALTER TABLE "PinnedCity" ADD CONSTRAINT "PinnedCity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
