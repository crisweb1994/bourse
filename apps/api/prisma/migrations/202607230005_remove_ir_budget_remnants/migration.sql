ALTER TABLE "InvestorRelationsGenerationRun"
  DROP COLUMN IF EXISTS "budgetReservedUsd";

ALTER TYPE "InvestorRelationsGenerationStatus"
  RENAME TO "InvestorRelationsGenerationStatus_old";

CREATE TYPE "InvestorRelationsGenerationStatus" AS ENUM (
  'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'
);

ALTER TABLE "InvestorRelationsGenerationRun"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "InvestorRelationsGenerationStatus"
    USING (
      CASE
        WHEN "status"::text = 'BUDGET_EXHAUSTED' THEN 'FAILED'
        ELSE "status"::text
      END
    )::"InvestorRelationsGenerationStatus",
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';

DROP TYPE "InvestorRelationsGenerationStatus_old";
