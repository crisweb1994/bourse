-- Persistent owner-token lease for network-bound earnings schedulers. This
-- keeps the database transaction short while preventing duplicate work across
-- API replicas.
CREATE TABLE "EarningsSchedulerLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningsSchedulerLease_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "EarningsSchedulerLease_leaseUntil_idx"
  ON "EarningsSchedulerLease"("leaseUntil");
