-- CreateIndex
CREATE INDEX "receiving_sessions_stationId_idx" ON "receiving_sessions"("stationId");

-- AddForeignKey
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
