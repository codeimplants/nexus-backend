-- Ledger: the partners' own books. Clients and what they owe, subscriptions we
-- buy and when they renew, who paid or received each rupee, and what the
-- partners owe each other. Money is integer paise; dates are IST calendar days.
--
-- Tables only, all new; nothing existing is altered beyond the foreign key from
-- LedgerPartner.adminId to Admin (ON DELETE SET NULL, so deleting an account
-- never deletes a partner or their history).
--
-- Written by hand because there is no local Postgres on the dev machine, so
-- `prisma migrate dev` cannot run here. The DDL below is exactly what
-- `prisma migrate diff --from-schema-datamodel <previous schema>
-- --to-schema-datamodel prisma/schema.prisma --script` emits.

-- CreateTable
CREATE TABLE "LedgerPartner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adminId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerShareSchedule" (
    "id" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "weights" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerShareSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPlan" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "cycleMonths" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "periodsBilled" INTEGER NOT NULL DEFAULT 0,
    "nextDueDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerCharge" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "planId" TEXT,
    "subscriptionId" TEXT,
    "expenseId" TEXT,
    "description" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerReceipt" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "mode" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "weights" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerSubscription" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "vendor" TEXT,
    "amountPaise" INTEGER,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "cycleMonths" INTEGER NOT NULL,
    "nextRenewal" DATE,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" TEXT,
    "defaultPayerId" TEXT,
    "clientId" TEXT,
    "rebillPaise" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerExpense" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "vendor" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "paidById" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "clientId" TEXT,
    "weights" JSONB,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerSettlement" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "mode" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerPartner_name_key" ON "LedgerPartner"("name");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerPartner_adminId_key" ON "LedgerPartner"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerShareSchedule_effectiveFrom_key" ON "LedgerShareSchedule"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerClient_name_key" ON "LedgerClient"("name");

-- CreateIndex
CREATE INDEX "LedgerPlan_clientId_idx" ON "LedgerPlan"("clientId");

-- CreateIndex
CREATE INDEX "LedgerPlan_isActive_nextDueDate_idx" ON "LedgerPlan"("isActive", "nextDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerCharge_expenseId_key" ON "LedgerCharge"("expenseId");

-- CreateIndex
CREATE INDEX "LedgerCharge_clientId_dueDate_idx" ON "LedgerCharge"("clientId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerCharge_planId_dueDate_key" ON "LedgerCharge"("planId", "dueDate");

-- CreateIndex
CREATE INDEX "LedgerReceipt_clientId_receivedOn_idx" ON "LedgerReceipt"("clientId", "receivedOn");

-- CreateIndex
CREATE INDEX "LedgerReceipt_receivedById_idx" ON "LedgerReceipt"("receivedById");

-- CreateIndex
CREATE INDEX "LedgerSubscription_isActive_nextRenewal_idx" ON "LedgerSubscription"("isActive", "nextRenewal");

-- CreateIndex
CREATE INDEX "LedgerExpense_paidOn_idx" ON "LedgerExpense"("paidOn");

-- CreateIndex
CREATE INDEX "LedgerExpense_paidById_idx" ON "LedgerExpense"("paidById");

-- CreateIndex
CREATE INDEX "LedgerExpense_category_idx" ON "LedgerExpense"("category");

-- CreateIndex
CREATE INDEX "LedgerSettlement_paidOn_idx" ON "LedgerSettlement"("paidOn");

-- AddForeignKey
ALTER TABLE "LedgerPartner" ADD CONSTRAINT "LedgerPartner_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPlan" ADD CONSTRAINT "LedgerPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCharge" ADD CONSTRAINT "LedgerCharge_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCharge" ADD CONSTRAINT "LedgerCharge_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LedgerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCharge" ADD CONSTRAINT "LedgerCharge_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "LedgerSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCharge" ADD CONSTRAINT "LedgerCharge_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "LedgerExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerReceipt" ADD CONSTRAINT "LedgerReceipt_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerReceipt" ADD CONSTRAINT "LedgerReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "LedgerPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerSubscription" ADD CONSTRAINT "LedgerSubscription_defaultPayerId_fkey" FOREIGN KEY ("defaultPayerId") REFERENCES "LedgerPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerSubscription" ADD CONSTRAINT "LedgerSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "LedgerPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "LedgerSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerSettlement" ADD CONSTRAINT "LedgerSettlement_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "LedgerPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerSettlement" ADD CONSTRAINT "LedgerSettlement_toId_fkey" FOREIGN KEY ("toId") REFERENCES "LedgerPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

