-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AiProviderType" AS ENUM ('ANTHROPIC', 'OPENAI_COMPATIBLE');

-- CreateEnum
CREATE TYPE "WebSearchProviderType" AS ENUM ('TAVILY', 'SEARXNG');

-- CreateEnum
CREATE TYPE "WebSearchPrimaryMode" AS ENUM ('NATIVE_FIRST', 'CUSTOM_ONLY');

-- CreateEnum
CREATE TYPE "ChatIntent" AS ENUM ('OPEN_RESEARCH', 'EXPLAIN_EXISTING', 'COMPARE_HISTORY', 'REFRESH_REQUIRED', 'VALIDATE_THESIS', 'SCOPE_CHANGE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ChatGenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM_NOTICE');

-- CreateEnum
CREATE TYPE "ChatMessageKind" AS ENUM ('TEXT', 'PROPOSAL', 'DELTA_SUMMARY', 'THESIS_REVIEW', 'ERROR_NOTICE');

-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('US', 'CN', 'HK');

-- CreateEnum
CREATE TYPE "DigestSession" AS ENUM ('PRE', 'POST');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WEBHOOK', 'FEISHU', 'DINGTALK', 'WECOM', 'TELEGRAM', 'SLACK');

-- CreateEnum
CREATE TYPE "AnalysisType" AS ENUM ('FUNDAMENTAL', 'VALUATION', 'INDUSTRY', 'RISK', 'TECHNICAL', 'SENTIMENT', 'SCENARIO', 'PORTFOLIO', 'GOVERNANCE', 'COMPREHENSIVE', 'DEBATE');

-- CreateEnum
CREATE TYPE "SectionType" AS ENUM ('FUNDAMENTAL', 'VALUATION', 'INDUSTRY', 'RISK', 'TECHNICAL', 'SENTIMENT', 'SCENARIO', 'PORTFOLIO', 'GOVERNANCE');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED');

-- CreateEnum
CREATE TYPE "Signal" AS ENUM ('BULLISH', 'NEUTRAL', 'BEARISH');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "exchange" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "yahooSymbol" TEXT,
    "sector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "notes" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProviderSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "providerType" "AiProviderType",
    "enabledModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "apiKeyEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "primaryModel" TEXT,
    "utilityModel" TEXT,

    CONSTRAINT "AiProviderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebSearchSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerType" "WebSearchProviderType" NOT NULL,
    "apiKey" TEXT,
    "baseUrl" TEXT,
    "primaryMode" "WebSearchPrimaryMode" NOT NULL DEFAULT 'NATIVE_FIRST',
    "timeoutMs" INTEGER,
    "budgetUsdPerRun" DECIMAL(10,4),
    "cacheTtlMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebSearchSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "markets" "Market"[],
    "sessions" "DigestSession"[],
    "channels" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigestSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "session" "DigestSession" NOT NULL,
    "channelType" "ChannelType" NOT NULL,
    "target" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "analysisType" "AnalysisType" NOT NULL,
    "question" TEXT,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiProviderSettingId" TEXT,
    "promptVersion" TEXT,
    "dataAsOf" TEXT,
    "generatedAt" TIMESTAMP(3),
    "summaryMarkdown" TEXT,
    "summaryJson" JSONB,
    "overallSignal" "Signal",
    "overallConfidence" "Confidence",
    "degradedSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisSection" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" "SectionType" NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "reportMarkdown" TEXT,
    "structuredJson" JSONB,
    "citations" JSONB,
    "errorMessage" TEXT,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "primaryStockId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatGeneration" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "intent" "ChatIntent" NOT NULL,
    "status" "ChatGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "contextSnapshot" JSONB NOT NULL,
    "analysisContextSnapshotId" TEXT,
    "linkedAnalysisRunId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "actualProvider" TEXT,
    "actualModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "groundedSources" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChatGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatAnalysisContextSnapshot" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAnalysisContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatStreamEvent" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatStreamEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "generationId" TEXT,
    "role" "ChatMessageRole" NOT NULL,
    "kind" "ChatMessageKind" NOT NULL,
    "status" "ChatMessageStatus" NOT NULL,
    "content" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "citationRefs" JSONB,
    "numericRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenResearchSnapshot" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "dataAsOf" TIMESTAMP(3) NOT NULL,
    "gatewayVersion" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "citationCandidates" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenResearchSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisEvidenceSnapshot" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "evidencePackVersion" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAsOf" JSONB NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "missingFields" TEXT[],
    "payload" JSONB NOT NULL,
    "sourceSnapshots" JSONB NOT NULL,
    "metadata" JSONB,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "AnalysisEvidenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE INDEX "Stock_sector_idx" ON "Stock"("sector");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_symbol_market_key" ON "Stock"("symbol", "market");

-- CreateIndex
CREATE INDEX "WatchlistItem_userId_order_idx" ON "WatchlistItem"("userId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_stockId_key" ON "WatchlistItem"("userId", "stockId");

-- CreateIndex
CREATE INDEX "AiProviderSetting_userId_idx" ON "AiProviderSetting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WebSearchSetting_userId_key" ON "WebSearchSetting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSubscription_userId_key" ON "DigestSubscription"("userId");

-- CreateIndex
CREATE INDEX "DeliveryRecord_userId_attemptedAt_idx" ON "DeliveryRecord"("userId", "attemptedAt");

-- CreateIndex
CREATE INDEX "DeliveryRecord_market_session_attemptedAt_idx" ON "DeliveryRecord"("market", "session", "attemptedAt");

-- CreateIndex
CREATE INDEX "Analysis_userId_degradedSource_idx" ON "Analysis"("userId", "degradedSource");

-- CreateIndex
CREATE INDEX "ResearchThread_userId_primaryStockId_updatedAt_idx" ON "ResearchThread"("userId", "primaryStockId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatGeneration_threadId_status_idx" ON "ChatGeneration"("threadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChatGeneration_threadId_clientRequestId_key" ON "ChatGeneration"("threadId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatAnalysisContextSnapshot_contentHash_key" ON "ChatAnalysisContextSnapshot"("contentHash");

-- CreateIndex
CREATE INDEX "ChatAnalysisContextSnapshot_analysisId_createdAt_idx" ON "ChatAnalysisContextSnapshot"("analysisId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatStreamEvent_generationId_sequence_idx" ON "ChatStreamEvent"("generationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ChatStreamEvent_generationId_sequence_key" ON "ChatStreamEvent"("generationId", "sequence");

-- CreateIndex
CREATE INDEX "ChatMessage_generationId_idx" ON "ChatMessage"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_sequence_key" ON "ChatMessage"("threadId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "OpenResearchSnapshot_generationId_key" ON "OpenResearchSnapshot"("generationId");

-- CreateIndex
CREATE INDEX "OpenResearchSnapshot_stockId_createdAt_idx" ON "OpenResearchSnapshot"("stockId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisEvidenceSnapshot_analysisId_key" ON "AnalysisEvidenceSnapshot"("analysisId");

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProviderSetting" ADD CONSTRAINT "AiProviderSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebSearchSetting" ADD CONSTRAINT "WebSearchSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestSubscription" ADD CONSTRAINT "DigestSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisSection" ADD CONSTRAINT "AnalysisSection_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchThread" ADD CONSTRAINT "ResearchThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchThread" ADD CONSTRAINT "ResearchThread_primaryStockId_fkey" FOREIGN KEY ("primaryStockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatGeneration" ADD CONSTRAINT "ChatGeneration_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ResearchThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatGeneration" ADD CONSTRAINT "ChatGeneration_analysisContextSnapshotId_fkey" FOREIGN KEY ("analysisContextSnapshotId") REFERENCES "ChatAnalysisContextSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatStreamEvent" ADD CONSTRAINT "ChatStreamEvent_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ChatGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ResearchThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ChatGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenResearchSnapshot" ADD CONSTRAINT "OpenResearchSnapshot_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ChatGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenResearchSnapshot" ADD CONSTRAINT "OpenResearchSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisEvidenceSnapshot" ADD CONSTRAINT "AnalysisEvidenceSnapshot_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
