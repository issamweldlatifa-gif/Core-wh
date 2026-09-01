-- Link receiving sessions to the station they were performed at.
-- Guarded so a re-run after a half-applied deploy cannot fail (see the
-- 20260901175952 migration for the incident this protects against).

-- CreateIndex
CREATE INDEX IF NOT EXISTS "receiving_sessions_stationId_idx" ON "receiving_sessions"("stationId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
