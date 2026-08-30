-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('ADMIN', 'CRM', 'OCR', 'API');

-- CreateEnum
CREATE TYPE "WarehouseOrderStatus" AS ENUM ('OPEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('OPEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PhysicalItemStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'STOWED', 'PICKED', 'SORTED', 'PACKED', 'SHIPPED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_ORDER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_ORDER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_ORDER_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_ITEM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_ITEM_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_ITEM_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'PHYSICAL_ITEM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PHYSICAL_ITEM_CANCELLED';

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "externalProductCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productType" TEXT,
    "description" TEXT,
    "attributes" JSONB,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_orders" (
    "id" TEXT NOT NULL,
    "externalOrderReference" TEXT NOT NULL,
    "externalCustomerReference" TEXT NOT NULL,
    "source" "OrderSource" NOT NULL DEFAULT 'ADMIN',
    "status" "WarehouseOrderStatus" NOT NULL DEFAULT 'OPEN',
    "warehouseId" TEXT,
    "note" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requestedQuantity" INTEGER NOT NULL,
    "externalLineReference" TEXT,
    "note" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_items" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "externalItemReference" TEXT,
    "status" "PhysicalItemStatus" NOT NULL DEFAULT 'EXPECTED',
    "currentLocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "physical_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_store_idx" ON "products"("store");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "products_store_externalProductCode_key" ON "products"("store", "externalProductCode");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_orders_externalOrderReference_key" ON "warehouse_orders"("externalOrderReference");

-- CreateIndex
CREATE INDEX "warehouse_orders_externalCustomerReference_idx" ON "warehouse_orders"("externalCustomerReference");

-- CreateIndex
CREATE INDEX "warehouse_orders_status_idx" ON "warehouse_orders"("status");

-- CreateIndex
CREATE INDEX "warehouse_orders_warehouseId_idx" ON "warehouse_orders"("warehouseId");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "order_items_status_idx" ON "order_items"("status");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_orderId_externalLineReference_key" ON "order_items"("orderId", "externalLineReference");

-- CreateIndex
CREATE UNIQUE INDEX "physical_items_itemCode_key" ON "physical_items"("itemCode");

-- CreateIndex
CREATE INDEX "physical_items_orderItemId_idx" ON "physical_items"("orderItemId");

-- CreateIndex
CREATE INDEX "physical_items_status_idx" ON "physical_items"("status");

-- CreateIndex
CREATE INDEX "physical_items_currentLocationId_idx" ON "physical_items"("currentLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "physical_items_orderItemId_externalItemReference_key" ON "physical_items"("orderItemId", "externalItemReference");

-- AddForeignKey
ALTER TABLE "warehouse_orders" ADD CONSTRAINT "warehouse_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_items" ADD CONSTRAINT "physical_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_items" ADD CONSTRAINT "physical_items_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 2 — C6 (design §8): quantity integrity at the DB level.
-- Prisma cannot express CHECK constraints; appended to the same migration
-- per the project convention (raw SQL inside the Prisma migration).
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_requestedQuantity_positive" CHECK ("requestedQuantity" > 0);
