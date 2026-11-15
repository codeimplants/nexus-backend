-- Platform Hardening register: the infrastructure gaps from the 2026-11-15 audit,
-- the risk each carries once we have paying users, and a pasteable brief so a
-- teammate can start one in their own AI session without re-deriving the audit.
--
-- Table only. The reference rows are seeded by HardeningSeedService on boot with
-- `upsert({ update: {} })`, so seeding is idempotent and NEVER overwrites a status,
-- owner or note the team has since edited in the UI. Adding an item means adding it
-- to that service's array, not writing another migration.
--
-- Written by hand because there is no local Postgres on the dev machine, so
-- `prisma migrate dev` cannot run here. The DDL below is exactly what
-- `prisma migrate diff --from-empty --to-schema-datamodel` emits for this model.

-- CreateTable
CREATE TABLE "HardeningItem" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "category" TEXT NOT NULL,
    "gap" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "aiBrief" TEXT NOT NULL,
    "scope" TEXT,
    "owner" TEXT,
    "evidence" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HardeningItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HardeningItem_key_key" ON "HardeningItem"("key");

-- CreateIndex
CREATE INDEX "HardeningItem_status_severity_idx" ON "HardeningItem"("status", "severity");

-- CreateIndex
CREATE INDEX "HardeningItem_category_idx" ON "HardeningItem"("category");
