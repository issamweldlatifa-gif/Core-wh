-- DropIndex
DROP INDEX "worker_task_assignments_stationId_idx";

-- CreateTable
CREATE TABLE "product_station_moves" (
    "id" TEXT NOT NULL,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "arrivalItemId" TEXT,
    "receivingProductId" TEXT,
    "reportLineId" TEXT,
    "receivingSessionId" TEXT,
    "expectedQuantity" INTEGER NOT NULL DEFAULT 0,
    "confirmedQuantity" INTEGER NOT NULL DEFAULT 0,
    "result" "ReceivingVerificationResult" NOT NULL DEFAULT 'CONFIRMED',
    "fromStationId" TEXT,
    "toDepartment" "StationDepartment" NOT NULL,
    "toStationId" TEXT,
    "actorId" TEXT,
    "reason" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_station_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_station_moves_toDepartment_acceptedAt_idx" ON "product_station_moves"("toDepartment", "acceptedAt");

-- CreateIndex
CREATE INDEX "product_station_moves_receivingProductId_idx" ON "product_station_moves"("receivingProductId");

-- CreateIndex
CREATE INDEX "product_station_moves_reportLineId_idx" ON "product_station_moves"("reportLineId");

-- CreateIndex
CREATE INDEX "product_station_moves_receivingSessionId_idx" ON "product_station_moves"("receivingSessionId");

-- AddForeignKey
ALTER TABLE "product_station_moves" ADD CONSTRAINT "product_station_moves_receivingProductId_fkey" FOREIGN KEY ("receivingProductId") REFERENCES "receiving_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_station_moves" ADD CONSTRAINT "product_station_moves_reportLineId_fkey" FOREIGN KEY ("reportLineId") REFERENCES "receiving_report_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_station_moves" ADD CONSTRAINT "product_station_moves_fromStationId_fkey" FOREIGN KEY ("fromStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_station_moves" ADD CONSTRAINT "product_station_moves_toStationId_fkey" FOREIGN KEY ("toStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
