DROP TABLE IF EXISTS "EarningsMetricFactProjection";
DROP TYPE IF EXISTS "EarningsMetricValueKind";
DROP TYPE IF EXISTS "EarningsFactDerivationKind";

DROP TABLE IF EXISTS "InvestorRelationsDetectionCursor";
DROP TABLE IF EXISTS "EarningsSchedulerLease";

DROP INDEX IF EXISTS "FilingDetectionCursor_nextCheckAt_leaseUntil_idx";
ALTER TABLE "FilingDetectionCursor"
  DROP COLUMN IF EXISTS "leaseUntil";
CREATE INDEX IF NOT EXISTS "FilingDetectionCursor_nextCheckAt_idx"
  ON "FilingDetectionCursor"("nextCheckAt");

UPDATE "InvestorRelationsEventFiling"
SET "relationType" = 'SUPPLEMENTS'
WHERE "relationType" = 'DUPLICATE_SOURCE';

ALTER TYPE "InvestorRelationsFilingRelation"
  RENAME TO "InvestorRelationsFilingRelation_old";

CREATE TYPE "InvestorRelationsFilingRelation" AS ENUM (
  'PRIMARY', 'SUPPLEMENTS', 'CORRECTS'
);

ALTER TABLE "InvestorRelationsEventFiling"
  ALTER COLUMN "relationType" TYPE "InvestorRelationsFilingRelation"
  USING ("relationType"::text::"InvestorRelationsFilingRelation");

DROP TYPE "InvestorRelationsFilingRelation_old";
