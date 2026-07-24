UPDATE "EarningsGenerationRun"
SET "status" = 'FAILED'
WHERE "status" = 'BUDGET_EXHAUSTED';

ALTER TABLE "EarningsGenerationRun"
  DROP COLUMN IF EXISTS "budgetReservedUsd";

ALTER TYPE "EarningsGenerationStatus" RENAME TO "EarningsGenerationStatus_old";

CREATE TYPE "EarningsGenerationStatus" AS ENUM (
  'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'
);

ALTER TABLE "EarningsGenerationRun"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "EarningsGenerationStatus"
    USING ("status"::text::"EarningsGenerationStatus"),
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';

DROP TYPE "EarningsGenerationStatus_old";
