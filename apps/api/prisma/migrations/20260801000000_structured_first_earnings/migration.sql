-- AlterEnum
ALTER TYPE "EarningsPeriodType" ADD VALUE 'NINE_M';

-- CreateTable
CREATE TABLE "FinancialDataSnapshot" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceNature" TEXT NOT NULL,
    "qualityTier" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "normalizedPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialDataSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningsStructuredSelection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "selectionVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "selectedPeriodId" TEXT,
    "diagnostics" JSONB NOT NULL,
    "knowledgeCutoffAt" TIMESTAMP(3) NOT NULL,
    "retryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningsStructuredSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelectionSnapshot" (
    "selectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'primary',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectionSnapshot_pkey" PRIMARY KEY ("selectionId","snapshotId")
);

-- CreateIndex
CREATE INDEX "FinancialDataSnapshot_stockId_retrievedAt_idx" ON "FinancialDataSnapshot"("stockId", "retrievedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialDataSnapshot_stockId_provider_contentHash_schemaVe_key" ON "FinancialDataSnapshot"("stockId", "provider", "contentHash", "schemaVersion");

-- CreateIndex
CREATE INDEX "EarningsStructuredSelection_eventId_createdAt_idx" ON "EarningsStructuredSelection"("eventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsStructuredSelection_eventId_selectionVersion_key" ON "EarningsStructuredSelection"("eventId", "selectionVersion");

-- AddForeignKey
ALTER TABLE "FinancialDataSnapshot" ADD CONSTRAINT "FinancialDataSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningsStructuredSelection" ADD CONSTRAINT "EarningsStructuredSelection_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EarningsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionSnapshot" ADD CONSTRAINT "SelectionSnapshot_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES "EarningsStructuredSelection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelectionSnapshot" ADD CONSTRAINT "SelectionSnapshot_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "FinancialDataSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
