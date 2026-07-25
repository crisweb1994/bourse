import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { InvestorRelationsQueryService } from './investor-relations-query.service';

function service(event: unknown = null) {
  const prisma = {
    investorRelationsEvent: {
      findFirst: async ({ where }: any) => {
        if (!event || (where.stockId && where.stockId !== 'stock-1')) return null;
        return event;
      },
    },
  };
  return new InvestorRelationsQueryService(prisma as any, {} as any);
}

test('IR detail rejects an event outside the expected stock scope', async () => {
  await assert.rejects(
    () => service({ currentRevision: {} }).detail('event-1', 'stock-2'),
    NotFoundException,
  );
});
