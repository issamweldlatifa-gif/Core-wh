-- AlterTable
ALTER TABLE "temporary_storage_items" ADD COLUMN     "stationId" TEXT;

-- CreateIndex
CREATE INDEX "temporary_storage_items_stationId_idx" ON "temporary_storage_items"("stationId");

