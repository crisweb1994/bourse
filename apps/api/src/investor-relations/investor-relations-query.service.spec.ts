import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { InvestorRelationsQueryService } from './investor-relations-query.service';

function service(enabled: boolean, event: unknown = null) {
  const prisma = {
    investorRelationsEvent: {
      findFirst: async ({ where }: any) => {
        if (!event || (where.stockId && where.stockId !== 'stock-1')) return null;
        return event;
      },
    },
  };
  const config = { get: () => String(enabled) };
  return new InvestorRelationsQueryService(prisma as any, config as any, {} as any);
}

test('IR detail is unavailable when the feature flag is disabled', async () => {
  await assert.rejects(() => service(false).detail('event-1'), NotFoundException);
});

test('IR detail rejects an event outside the expected stock scope', async () => {
  await assert.rejects(
    () => service(true, { currentRevision: {} }).detail('event-1', 'stock-2'),
    NotFoundException,
  );
});
