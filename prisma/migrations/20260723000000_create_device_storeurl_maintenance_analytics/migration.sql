-- Creates four tables that existed in the database but in no migration:
-- Device, AppAnalytics, StoreUrl, MaintenanceMode.
--
-- They were originally created with `prisma db push` against the Neon branches,
-- so the migration history could never rebuild a database from scratch: the
-- next migration (20260724000000_add_engagement_models) does ALTER TABLE
-- "Device" and failed with 42P01 "relation \"Device\" does not exist" on any
-- fresh database. This migration is dated before it to close that gap.
--
-- Device is deliberately created WITHOUT make/model/manufacturer/endUserId and
-- without Device_endUserId_idx — 20260724000000 adds those, and would fail with
-- "column already exists" if they were created here.

-- CreateTable: Device
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "buildNumber" TEXT,
    "lastCheckIn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AppAnalytics
CREATE TABLE "AppAnalytics" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "version" TEXT,
    "eventType" TEXT NOT NULL,
    "deviceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AppAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StoreUrl
CREATE TABLE "StoreUrl" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "storeUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable: MaintenanceMode
CREATE TABLE "MaintenanceMode" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT 'Under Maintenance',
    "message" TEXT NOT NULL DEFAULT 'We are currently performing maintenance. Please check back soon.',
    "estimatedEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceMode_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "Device_appId_deviceId_key" ON "Device"("appId", "deviceId");
CREATE INDEX "Device_appId_platform_idx" ON "Device"("appId", "platform");
CREATE INDEX "Device_lastCheckIn_idx" ON "Device"("lastCheckIn");

CREATE INDEX "AppAnalytics_appId_date_idx" ON "AppAnalytics"("appId", "date");
CREATE INDEX "AppAnalytics_appId_eventType_idx" ON "AppAnalytics"("appId", "eventType");
CREATE INDEX "AppAnalytics_platform_version_idx" ON "AppAnalytics"("platform", "version");

CREATE UNIQUE INDEX "StoreUrl_appId_platform_key" ON "StoreUrl"("appId", "platform");

CREATE UNIQUE INDEX "MaintenanceMode_appId_key" ON "MaintenanceMode"("appId");

-- Foreign keys
ALTER TABLE "Device"
    ADD CONSTRAINT "Device_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppAnalytics"
    ADD CONSTRAINT "AppAnalytics_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreUrl"
    ADD CONSTRAINT "StoreUrl_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaintenanceMode"
    ADD CONSTRAINT "MaintenanceMode_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;
