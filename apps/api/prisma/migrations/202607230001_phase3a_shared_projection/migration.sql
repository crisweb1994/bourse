DO $$ BEGIN
  CREATE TYPE "EarningsMetricValueKind" AS ENUM ('SCALAR', 'RANGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EarningsFactDerivationKind" AS ENUM ('SOURCE', 'YTD_DIFFERENCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Filing" ADD COLUMN IF NOT EXISTS "language" TEXT;

CREATE TABLE IF NOT EXISTS "EarningsMetricFactProjection" (
  "id" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "metricFactId" TEXT NOT NULL,
  "metricCode" TEXT NOT NULL,
  "valueKind" "EarningsMetricValueKind" NOT NULL,
  "scalarValue" DECIMAL(30,8),
  "rangeMin" DECIMAL(30,8),
  "rangeMax" DECIMAL(30,8),
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "scale" INTEGER NOT NULL,
  "periodStartOn" DATE,
  "periodEndOn" DATE NOT NULL,
  "periodKind" TEXT NOT NULL,
  "accumulation" TEXT NOT NULL,
  "accountingBasis" TEXT NOT NULL,
  "consolidationScope" "EarningsReportingScope" NOT NULL,
  "checkStatus" TEXT NOT NULL,
  "reconcileStatus" TEXT NOT NULL,
  "provenance" JSONB NOT NULL,
  "derivationKind" "EarningsFactDerivationKind" NOT NULL DEFAULT 'SOURCE',
  "inputMetricFactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "isCurrent" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "EarningsMetricFactProjection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EarningsMetricFactProjection_revisionId_metricFactId_key"
  ON "EarningsMetricFactProjection"("revisionId", "metricFactId");
CREATE INDEX IF NOT EXISTS "EarningsMetricFactProjection_stockId_metricCode_periodEndOn_idx"
  ON "EarningsMetricFactProjection"("stockId", "metricCode", "periodEndOn", "isCurrent");
CREATE INDEX IF NOT EXISTS "EarningsMetricFactProjection_eventId_isCurrent_idx"
  ON "EarningsMetricFactProjection"("eventId", "isCurrent");

DO $$ BEGIN
  ALTER TABLE "EarningsMetricFactProjection"
    ADD CONSTRAINT "EarningsMetricFactProjection_revisionId_fkey"
    FOREIGN KEY ("revisionId") REFERENCES "EarningsCardRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsMetricFactProjection"
    ADD CONSTRAINT "EarningsMetricFactProjection_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "EarningsEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EarningsMetricFactProjection"
    ADD CONSTRAINT "EarningsMetricFactProjection_stockId_fkey"
    FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
