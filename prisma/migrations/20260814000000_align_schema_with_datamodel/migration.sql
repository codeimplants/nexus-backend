-- Brings the migration chain back in line with schema.prisma.
--
-- Everything below already existed on the Neon branches but in no migration:
-- it was applied there with `prisma db push`, which writes to the database and
-- records nothing. A database rebuilt purely from migrations was therefore
-- missing these columns and indexes, and Prisma reported drift on every start.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--                       --to-schema-datamodel  prisma/schema.prisma --script
-- after 20260723000000 made the earlier migrations apply cleanly.
--
-- The ADD COLUMN ... NOT NULL statements carry no DEFAULT (standard Prisma
-- output for @updatedAt). That is safe here only because every table is empty
-- at the time this runs. Applying it to a populated table would fail — which is
-- moot for the Neon databases, since those were abandoned rather than migrated.

-- DropForeignKey
ALTER TABLE "VersionRule" DROP CONSTRAINT "VersionRule_appId_fkey";

-- DropIndex
DROP INDEX "App_appId_key";

-- AlterTable
ALTER TABLE "Admin" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "App" ADD COLUMN     "description" TEXT,
ADD COLUMN     "icon" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "minVersionAndroid" TEXT,
ADD COLUMN     "minVersionIos" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "appId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "adminEmail" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "VersionRule" DROP COLUMN "minVersion",
ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rolloutPercentage" DOUBLE PRECISION NOT NULL DEFAULT 100,
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "AuditLog_adminId_idx" ON "AuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_action_idx" ON "AuditLog"("entity", "action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "VersionRule_appId_platform_environment_idx" ON "VersionRule"("appId", "platform", "environment");

-- CreateIndex
CREATE INDEX "VersionRule_isActive_idx" ON "VersionRule"("isActive");

-- AddForeignKey
ALTER TABLE "VersionRule" ADD CONSTRAINT "VersionRule_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;
