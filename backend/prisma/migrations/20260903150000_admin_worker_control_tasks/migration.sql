-- COMMAND #3 — Worker Control: block/unblock/remove workers + admin task
-- assignments. Additive only: a new table, enum values, indexes. All
-- statements are guarded so the migration is re-runnable, exactly like every
-- migration in this repo; the same statements are mirrored by the boot repair.

DO $$ BEGIN CREATE TYPE "AssignmentStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_CANCELLED';

CREATE TABLE IF NOT EXISTS "worker_task_assignments" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "relatedType" TEXT,
    "relatedCode" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "note" TEXT,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_task_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "worker_task_assignments_workerId_status_idx" ON "worker_task_assignments"("workerId", "status");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_status_idx" ON "worker_task_assignments"("status");

DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
