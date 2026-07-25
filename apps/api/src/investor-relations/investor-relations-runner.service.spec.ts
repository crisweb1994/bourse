import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestorRelationsRunnerService } from './investor-relations-runner.service';

test('reuses an event when another provider returns the same activity content', async () => {
  let creates = 0;
  const existing = {
    id: 'event-1',
    activityType: 'INSTITUTIONAL_RESEARCH',
    filingLinks: [{ filing: { contentHash: 'same-hash', sourceGroupId: null } }],
  };
  const tx = {
    $executeRaw: async () => undefined,
    investorRelationsEvent: {
      findMany: async () => [existing],
      create: async () => { creates += 1; return { id: 'event-2' }; },
    },
  };
  const prisma = { $transaction: async (callback: any) => callback(tx) };
  const runner = new InvestorRelationsRunnerService(
    prisma as any,
    { get: () => undefined } as any,
    {} as any,
  );
  const result = await (runner as any).ensureEvent(
    { id: 'stock-1' },
    { title: '另一来源标题', contentHash: 'same-hash', publishedAt: new Date('2026-07-02') },
    '2026-07-01',
    'INSTITUTIONAL_RESEARCH',
  );
  assert.equal(result.event.id, 'event-1');
  assert.equal(result.relationType, 'SUPPLEMENTS');
  assert.equal(creates, 0);
});

test('does not merge same-day activities solely because their titles are generic', async () => {
  let creates = 0;
  const tx = {
    $executeRaw: async () => undefined,
    investorRelationsEvent: {
      findMany: async () => [{
        id: 'event-1',
        activityType: 'INSTITUTIONAL_RESEARCH',
        filingLinks: [{ filing: { contentHash: 'first-hash', sourceGroupId: null } }],
      }],
      create: async () => { creates += 1; return { id: 'event-2' }; },
    },
  };
  const runner = new InvestorRelationsRunnerService(
    { $transaction: async (callback: any) => callback(tx) } as any,
    { get: () => undefined } as any,
    {} as any,
  );
  const result = await (runner as any).ensureEvent(
    { id: 'stock-1' },
    { title: '机构调研活动记录表', contentHash: 'second-hash', sourceGroupId: null, publishedAt: new Date('2026-07-02') },
    '2026-07-01',
    'INSTITUTIONAL_RESEARCH',
  );
  assert.equal(result.event.id, 'event-2');
  assert.equal(result.relationType, 'PRIMARY');
  assert.equal(creates, 1);
});
