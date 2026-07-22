-- Additive earnings-brief migration. The existing database contains legacy
-- columns that are intentionally preserved; do not replace this with db push.

DO $$ BEGIN
  CREATE TYPE "FilingDocumentKind" AS ENUM ('PRIMARY', 'EARNINGS_RELEASE', 'PDF', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "FilingDerivationStatus" AS ENUM ('COMPLETE', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsPeriodType" AS ENUM ('Q1', 'Q2', 'Q3', 'H1', 'FY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsReportingScope" AS ENUM ('CONSOLIDATED', 'PARENT', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsRelationType" AS ENUM ('SUPPLEMENTS', 'CORRECTS', 'SUPERSEDES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsCardRevisionStatus" AS ENUM ('PARTIAL', 'COMPLETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BUDGET_EXHAUSTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsGenerationStage" AS ENUM ('DISCOVER', 'FETCH', 'DERIVE', 'EXTRACT', 'CHECK', 'RECONCILE', 'INTERPRET', 'PERSIST', 'DONE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EarningsDeliveryKind" AS ENUM ('NEW_CARD', 'UPDATE', 'CORRECTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'BUDGET_EXHAUSTED';
ALTER TYPE "ChatIntent" ADD VALUE IF NOT EXISTS 'EARNINGS_BRIEF';

-- The running application already reads this field; preserve all other
-- legacy Analysis columns instead of making the destructive db-push diff.
ALTER TABLE "Analysis" ADD COLUMN IF NOT EXISTS "question" TEXT;
ALTER TABLE "ChatGeneration" ADD COLUMN IF NOT EXISTS "earningsRevisionId" TEXT;
ALTER TABLE "DigestSubscription" ADD COLUMN IF NOT EXISTS "earningsImmediateEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "Filing" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "sourceGroupId" TEXT,
  "formType" TEXT NOT NULL,
  "documentKind" "FilingDocumentKind" NOT NULL,
  "title" TEXT,
  "sourceUrl" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "mimeType" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "rawContent" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Filing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FilingDerivation" (
  "id" TEXT NOT NULL,
  "filingId" TEXT NOT NULL,
  "derivationKey" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "status" "FilingDerivationStatus" NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "pages" JSONB,
  "sections" JSONB,
  "extraction" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FilingDerivation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EarningsGuidance" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "filingId" TEXT,
  "metricCode" TEXT NOT NULL,
  "targetPeriodEndOn" DATE NOT NULL,
  "targetPeriodType" "EarningsPeriodType" NOT NULL,
  "valueMin" DECIMAL(30,8) NOT NULL,
  "valueMax" DECIMAL(30,8) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "scale" INTEGER NOT NULL DEFAULT 1,
  "accountingBasis" TEXT NOT NULL,
  "consolidationScope" "EarningsReportingScope" NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "provider" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "sourceSpan" JSONB NOT NULL,
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EarningsGuidance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EarningsConsensusSnapshot" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "metricCode" TEXT NOT NULL,
  "periodEndOn" DATE NOT NULL,
  "periodType" TEXT NOT NULL,
  "value" DECIMAL(30,8) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "asOf" TIMESTAMP(3) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provider" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "analystCount" INTEGER,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "EarningsConsensusSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EarningsGuidance" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
UPDATE "EarningsGuidance" SET "dedupeKey" = md5("id") WHERE "dedupeKey" IS NULL;
ALTER TABLE "EarningsGuidance" ALTER COLUMN "dedupeKey" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "EarningsEvent" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "periodEndOn" DATE NOT NULL,
  "periodType" "EarningsPeriodType" NOT NULL,
  "reportingScope" "EarningsReportingScope" NOT NULL,
  "fiscalYear" INTEGER NOT NULL,
  "fiscalQuarter" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EarningsEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EarningsEventFiling" (
  "eventId" TEXT NOT NULL,
  "filingId" TEXT NOT NULL,
  "relationType" "EarningsRelationType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EarningsEventFiling_pkey" PRIMARY KEY ("eventId", "filingId")
);

CREATE TABLE IF NOT EXISTS "EarningsCard" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "currentRevisionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EarningsCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EarningsCardRevision" (
  "id" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "revisionNo" INTEGER NOT NULL,
  "status" "EarningsCardRevisionStatus" NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "model" TEXT,
  "payload" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "EarningsCardRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EarningsGenerationRun" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "eventId" TEXT,
  "requestedByUserId" TEXT,
  "cardRevisionId" TEXT,
  "clientRequestId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "sourceDescriptor" JSONB NOT NULL,
  "status" "EarningsGenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" "EarningsGenerationStage" NOT NULL DEFAULT 'DISCOVER',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "retryable" BOOLEAN NOT NULL DEFAULT true,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "budgetReservedUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "EarningsGenerationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FilingDetectionCursor" (
  "stockId" TEXT NOT NULL,
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastDiscoveredAt" TIMESTAMP(3),
  "lastSourceDocumentId" TEXT,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FilingDetectionCursor_pkey" PRIMARY KEY ("stockId")
);

CREATE TABLE IF NOT EXISTS "EarningsDeliveryRecord" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "previousRevisionId" TEXT,
  "kind" "EarningsDeliveryKind" NOT NULL,
  "channelType" "ChannelType" NOT NULL,
  "target" TEXT NOT NULL,
  "status" "DeliveryStatus" NOT NULL,
  "httpStatus" INTEGER,
  "error" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "EarningsDeliveryRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Filing_provider_sourceDocumentId_key" ON "Filing"("provider", "sourceDocumentId");
CREATE INDEX IF NOT EXISTS "Filing_stockId_publishedAt_idx" ON "Filing"("stockId", "publishedAt");
CREATE INDEX IF NOT EXISTS "Filing_contentHash_idx" ON "Filing"("contentHash");
CREATE UNIQUE INDEX IF NOT EXISTS "FilingDerivation_derivationKey_key" ON "FilingDerivation"("derivationKey");
CREATE INDEX IF NOT EXISTS "FilingDerivation_filingId_createdAt_idx" ON "FilingDerivation"("filingId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsEvent_stockId_periodEndOn_periodType_reportingScope_key" ON "EarningsEvent"("stockId", "periodEndOn", "periodType", "reportingScope");
CREATE INDEX IF NOT EXISTS "EarningsEvent_stockId_periodEndOn_idx" ON "EarningsEvent"("stockId", "periodEndOn");
CREATE INDEX IF NOT EXISTS "EarningsEventFiling_filingId_idx" ON "EarningsEventFiling"("filingId");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsCard_eventId_key" ON "EarningsCard"("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsCard_currentRevisionId_key" ON "EarningsCard"("currentRevisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsCardRevision_cardId_revisionNo_key" ON "EarningsCardRevision"("cardId", "revisionNo");
CREATE INDEX IF NOT EXISTS "EarningsCardRevision_cardId_generatedAt_idx" ON "EarningsCardRevision"("cardId", "generatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsGenerationRun_idempotencyKey_key" ON "EarningsGenerationRun"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsGenerationRun_requestedByUserId_clientRequestId_key" ON "EarningsGenerationRun"("requestedByUserId", "clientRequestId");
CREATE INDEX IF NOT EXISTS "EarningsGenerationRun_stockId_createdAt_idx" ON "EarningsGenerationRun"("stockId", "createdAt");
CREATE INDEX IF NOT EXISTS "EarningsGenerationRun_status_createdAt_idx" ON "EarningsGenerationRun"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "FilingDetectionCursor_nextCheckAt_leaseUntil_idx" ON "FilingDetectionCursor"("nextCheckAt", "leaseUntil");
CREATE INDEX IF NOT EXISTS "EarningsGuidance_stockId_targetPeriodEndOn_targetPeriodType_metricCode_issuedAt_idx" ON "EarningsGuidance"("stockId", "targetPeriodEndOn", "targetPeriodType", "metricCode", "issuedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsGuidance_dedupeKey_key" ON "EarningsGuidance"("dedupeKey");
CREATE INDEX IF NOT EXISTS "EarningsGuidance_filingId_idx" ON "EarningsGuidance"("filingId");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsConsensusSnapshot_stockId_metricCode_periodEndOn_periodType_provider_asOf_key" ON "EarningsConsensusSnapshot"("stockId", "metricCode", "periodEndOn", "periodType", "provider", "asOf");
CREATE INDEX IF NOT EXISTS "EarningsConsensusSnapshot_stockId_periodEndOn_periodType_metricCode_asOf_idx" ON "EarningsConsensusSnapshot"("stockId", "periodEndOn", "periodType", "metricCode", "asOf");
CREATE UNIQUE INDEX IF NOT EXISTS "EarningsDeliveryRecord_dedupeKey_key" ON "EarningsDeliveryRecord"("dedupeKey");
CREATE INDEX IF NOT EXISTS "EarningsDeliveryRecord_userId_stockId_attemptedAt_idx" ON "EarningsDeliveryRecord"("userId", "stockId", "attemptedAt");
CREATE INDEX IF NOT EXISTS "EarningsDeliveryRecord_revisionId_status_idx" ON "EarningsDeliveryRecord"("revisionId", "status");

DO $$ BEGIN
  ALTER TABLE "Filing" ADD CONSTRAINT "Filing_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FilingDerivation" ADD CONSTRAINT "FilingDerivation_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGuidance" ADD CONSTRAINT "EarningsGuidance_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGuidance" ADD CONSTRAINT "EarningsGuidance_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsConsensusSnapshot" ADD CONSTRAINT "EarningsConsensusSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsEvent" ADD CONSTRAINT "EarningsEvent_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsEventFiling" ADD CONSTRAINT "EarningsEventFiling_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EarningsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsEventFiling" ADD CONSTRAINT "EarningsEventFiling_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsCard" ADD CONSTRAINT "EarningsCard_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EarningsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsCard" ADD CONSTRAINT "EarningsCard_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "EarningsCardRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsCardRevision" ADD CONSTRAINT "EarningsCardRevision_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "EarningsCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGenerationRun" ADD CONSTRAINT "EarningsGenerationRun_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGenerationRun" ADD CONSTRAINT "EarningsGenerationRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EarningsEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGenerationRun" ADD CONSTRAINT "EarningsGenerationRun_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsGenerationRun" ADD CONSTRAINT "EarningsGenerationRun_cardRevisionId_fkey" FOREIGN KEY ("cardRevisionId") REFERENCES "EarningsCardRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "FilingDetectionCursor" ADD CONSTRAINT "FilingDetectionCursor_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsDeliveryRecord" ADD CONSTRAINT "EarningsDeliveryRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsDeliveryRecord" ADD CONSTRAINT "EarningsDeliveryRecord_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsDeliveryRecord" ADD CONSTRAINT "EarningsDeliveryRecord_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "EarningsCardRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChatGeneration" ADD CONSTRAINT "ChatGeneration_earningsRevisionId_fkey" FOREIGN KEY ("earningsRevisionId") REFERENCES "EarningsCardRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
