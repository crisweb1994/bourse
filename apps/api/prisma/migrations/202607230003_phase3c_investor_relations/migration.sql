ALTER TYPE "ChatIntent" ADD VALUE IF NOT EXISTS 'INVESTOR_RELATIONS';

DO $$ BEGIN
  CREATE TYPE "InvestorRelationsActivityType" AS ENUM (
    'INSTITUTIONAL_RESEARCH', 'EARNINGS_BRIEFING', 'ANALYST_MEETING',
    'ROADSHOW', 'PHONE_CALL', 'SITE_VISIT', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InvestorRelationsFilingRelation" AS ENUM (
    'PRIMARY', 'SUPPLEMENTS', 'CORRECTS', 'DUPLICATE_SOURCE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InvestorRelationsRevisionStatus" AS ENUM ('PARTIAL', 'COMPLETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InvestorRelationsGenerationStatus" AS ENUM (
    'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InvestorRelationsGenerationStage" AS ENUM (
    'DISCOVER', 'FETCH', 'DERIVE', 'EXTRACT', 'CHECK', 'PERSIST', 'DONE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ChatGeneration" ADD COLUMN IF NOT EXISTS "investorRelationsRevisionId" TEXT;

CREATE TABLE IF NOT EXISTS "InvestorRelationsEvent" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "activityType" "InvestorRelationsActivityType" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "currentRevisionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InvestorRelationsEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InvestorRelationsEventFiling" (
  "eventId" TEXT NOT NULL,
  "filingId" TEXT NOT NULL,
  "relationType" "InvestorRelationsFilingRelation" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvestorRelationsEventFiling_pkey" PRIMARY KEY ("eventId", "filingId")
);

CREATE TABLE IF NOT EXISTS "InvestorRelationsRevision" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "revisionNo" INTEGER NOT NULL,
  "status" "InvestorRelationsRevisionStatus" NOT NULL,
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
  CONSTRAINT "InvestorRelationsRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InvestorRelationsGenerationRun" (
  "id" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "eventId" TEXT,
  "requestedByUserId" TEXT,
  "revisionId" TEXT,
  "clientRequestId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "sourceDescriptor" JSONB NOT NULL,
  "status" "InvestorRelationsGenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" "InvestorRelationsGenerationStage" NOT NULL DEFAULT 'DISCOVER',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "retryable" BOOLEAN NOT NULL DEFAULT true,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "InvestorRelationsGenerationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InvestorRelationsDetectionCursor" (
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
  CONSTRAINT "InvestorRelationsDetectionCursor_pkey" PRIMARY KEY ("stockId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvestorRelationsEvent_currentRevisionId_key" ON "InvestorRelationsEvent"("currentRevisionId");
CREATE INDEX IF NOT EXISTS "InvestorRelationsEvent_stockId_occurredAt_idx" ON "InvestorRelationsEvent"("stockId", "occurredAt");
CREATE INDEX IF NOT EXISTS "InvestorRelationsEventFiling_filingId_idx" ON "InvestorRelationsEventFiling"("filingId");
CREATE UNIQUE INDEX IF NOT EXISTS "InvestorRelationsRevision_eventId_revisionNo_key" ON "InvestorRelationsRevision"("eventId", "revisionNo");
CREATE INDEX IF NOT EXISTS "InvestorRelationsRevision_eventId_generatedAt_idx" ON "InvestorRelationsRevision"("eventId", "generatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "InvestorRelationsGenerationRun_idempotencyKey_key" ON "InvestorRelationsGenerationRun"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "InvestorRelationsGenerationRun_requestedByUserId_clientRequ_key" ON "InvestorRelationsGenerationRun"("requestedByUserId", "clientRequestId");
CREATE INDEX IF NOT EXISTS "InvestorRelationsGenerationRun_status_createdAt_idx" ON "InvestorRelationsGenerationRun"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "InvestorRelationsGenerationRun_stockId_createdAt_idx" ON "InvestorRelationsGenerationRun"("stockId", "createdAt");
CREATE INDEX IF NOT EXISTS "InvestorRelationsDetectionCursor_nextCheckAt_leaseUntil_idx" ON "InvestorRelationsDetectionCursor"("nextCheckAt", "leaseUntil");

DO $$ BEGIN ALTER TABLE "InvestorRelationsEvent" ADD CONSTRAINT "InvestorRelationsEvent_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsEventFiling" ADD CONSTRAINT "InvestorRelationsEventFiling_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InvestorRelationsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsEventFiling" ADD CONSTRAINT "InvestorRelationsEventFiling_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsRevision" ADD CONSTRAINT "InvestorRelationsRevision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InvestorRelationsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsEvent" ADD CONSTRAINT "InvestorRelationsEvent_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "InvestorRelationsRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsGenerationRun" ADD CONSTRAINT "InvestorRelationsGenerationRun_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsGenerationRun" ADD CONSTRAINT "InvestorRelationsGenerationRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InvestorRelationsEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsGenerationRun" ADD CONSTRAINT "InvestorRelationsGenerationRun_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsGenerationRun" ADD CONSTRAINT "InvestorRelationsGenerationRun_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "InvestorRelationsRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "InvestorRelationsDetectionCursor" ADD CONSTRAINT "InvestorRelationsDetectionCursor_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ChatGeneration" ADD CONSTRAINT "ChatGeneration_investorRelationsRevisionId_fkey" FOREIGN KEY ("investorRelationsRevisionId") REFERENCES "InvestorRelationsRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
