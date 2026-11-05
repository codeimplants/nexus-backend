-- Phones running the Nexus admin app, for push alerts.
CREATE TABLE "AdminPushToken" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminPushToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminPushToken_token_key" ON "AdminPushToken"("token");
CREATE INDEX "AdminPushToken_adminId_idx" ON "AdminPushToken"("adminId");

ALTER TABLE "AdminPushToken" ADD CONSTRAINT "AdminPushToken_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
