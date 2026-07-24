-- HK earnings uses the shared Filing tables. This index supports bilingual
-- source grouping without coupling the rollout to investor-relations tables.
CREATE INDEX IF NOT EXISTS "Filing_stockId_sourceGroupId_idx"
  ON "Filing"("stockId", "sourceGroupId");
