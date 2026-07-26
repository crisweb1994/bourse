/*
  Warnings:

  - You are about to drop the column `costUsd` on the `EarningsCardRevision` table. All the data in the column will be lost.
  - You are about to drop the column `costUsd` on the `EarningsGenerationRun` table. All the data in the column will be lost.
  - You are about to drop the column `costUsd` on the `InvestorRelationsGenerationRun` table. All the data in the column will be lost.
  - You are about to drop the column `costUsd` on the `InvestorRelationsRevision` table. All the data in the column will be lost.
  - You are about to drop the column `budgetUsdPerRun` on the `WebSearchSetting` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER;

-- AlterTable
ALTER TABLE "EarningsCardRevision" DROP COLUMN "costUsd";

-- AlterTable
ALTER TABLE "EarningsGenerationRun" DROP COLUMN "costUsd";

-- AlterTable
ALTER TABLE "InvestorRelationsGenerationRun" DROP COLUMN "costUsd";

-- AlterTable
ALTER TABLE "InvestorRelationsRevision" DROP COLUMN "costUsd";

-- AlterTable
ALTER TABLE "WebSearchSetting" DROP COLUMN "budgetUsdPerRun";
