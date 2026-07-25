-- PostgreSQL truncates identifiers to 63 bytes. Give the long composite
-- indexes stable explicit names so future Prisma diffs remain clean.
ALTER INDEX IF EXISTS "EarningsGuidance_stockId_targetPeriodEndOn_targetPeriodType_met"
  RENAME TO "EarningsGuidance_lookup_idx";

ALTER INDEX IF EXISTS "EarningsConsensusSnapshot_stockId_metricCode_periodEndOn_period"
  RENAME TO "EarningsConsensusSnapshot_identity_key";

ALTER INDEX IF EXISTS "EarningsConsensusSnapshot_stockId_periodEndOn_periodType_metric"
  RENAME TO "EarningsConsensusSnapshot_lookup_idx";
