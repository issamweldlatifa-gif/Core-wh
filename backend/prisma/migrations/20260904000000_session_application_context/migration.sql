-- CreateEnum
CREATE TYPE "ApplicationKind" AS ENUM ('ADMIN_WEB', 'WORKER_NATIVE');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "application" "ApplicationKind" NOT NULL DEFAULT 'ADMIN_WEB';
