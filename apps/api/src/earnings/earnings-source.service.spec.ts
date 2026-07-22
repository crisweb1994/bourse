import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilingPort } from '@bourse/analysis';
import { buildParserDerivationKey, EarningsSourceService } from './earnings-source.service';
import { EarningsSourceError } from './earnings-source.service';

const stock = {
  id: 'stock-1',
  symbol: 'NVDA',
  name: 'NVIDIA',
  market: 'US',
  exchange: 'NASDAQ',
  currency: 'USD',
  yahooSymbol: null,
  sector: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

test('EarningsSourceService skips a non-earnings 8-K and persists EX-99.1 once', async () => {
  const summaries = [
    summary('accession-new', 'https://www.sec.gov/Archives/new/main.htm'),
    summary('accession-earnings', 'https://www.sec.gov/Archives/earnings/main.htm'),
  ];
  const port: FilingPort = {
    async searchFilings() {
      return envelope(summaries);
    },
    async getFiling(input) {
      const isEarnings = input.id === 'accession-earnings';
      return envelope({
        ...summary(input.id, input.filingUrl ?? ''),
        sourceDocumentId: `${input.id}:${isEarnings ? 'earnings.htm' : 'main.htm'}`,
        documentKind: isEarnings ? 'EARNINGS_RELEASE' : 'PRIMARY',
        text: isEarnings ? 'Revenue was 10 billion.' : 'Unrelated current report.',
        rawContent: new TextEncoder().encode('raw'),
        contentHash: isEarnings ? 'b'.repeat(64) : 'a'.repeat(64),
        retrievedAt: '2026-07-20T00:00:00.000Z',
      });
    },
  };
  const creates: any[] = [];
  const prisma = {
    filing: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }: any) => {
        creates.push(data);
        return { id: 'filing-db', ...data };
      },
    },
    filingDerivation: {
      upsert: async ({ create }: any) => ({ id: 'derivation-db', ...create }),
    },
  };
  const service = new EarningsSourceService(prisma as any, port, port);
  const prepared = await service.discoverAndIngest(stock);
  assert.equal(prepared.sourceDocumentId, 'accession-earnings:earnings.htm');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].documentKind, 'EARNINGS_RELEASE');
});

test('EarningsSourceService preserves filing metadata for structured fallback', async () => {
  const port: FilingPort = {
    async searchFilings() {
      return envelope([summary('accession-unreadable', 'https://www.sec.gov/Archives/unreadable/main.htm')]);
    },
    async getFiling(input) {
      return envelope({
        ...summary(input.id, input.filingUrl ?? ''),
        sourceDocumentId: `${input.id}:release.pdf`,
        documentKind: 'EARNINGS_RELEASE' as const,
        text: undefined,
        rawContent: new Uint8Array([1, 2, 3]),
        contentHash: 'c'.repeat(64),
        retrievedAt: '2026-07-20T00:00:00.000Z',
      });
    },
  };
  const service = new EarningsSourceService({
    filing: { findFirst: async () => null },
  } as any, port, port);

  await assert.rejects(
    () => service.discoverAndIngest(stock),
    (error: unknown) => {
      assert.ok(error instanceof EarningsSourceError);
      assert.equal(error.code, 'BODY_UNREADABLE');
      assert.deepEqual(error.fallbackSource, {
        kind: 'structuredFallback',
        provider: 'sec-edgar',
        sourceDocumentId: 'accession-unreadable:release.pdf',
        sourceGroupId: 'accession-unreadable',
        formType: '8-K',
        title: 'Current report',
        sourceUrl: 'https://www.sec.gov/Archives/unreadable/main.htm',
        publishedAt: '2026-07-20T00:00:00.000Z',
        reason: 'BODY_UNREADABLE',
      });
      return true;
    },
  );
});

test('EarningsSourceService advances from an already-linked filing to the next supplement', async () => {
  const summaries = [
    { ...summary('quarterly-linked', 'https://www.sec.gov/Archives/q/10q.htm'), formType: '10-Q' },
    summary('release-new', 'https://www.sec.gov/Archives/r/8k.htm'),
  ];
  const fetched: string[] = [];
  const port: FilingPort = {
    async searchFilings() { return envelope(summaries); },
    async getFiling(input) {
      fetched.push(input.id);
      return envelope({
        ...summaries.find((item) => item.id === input.id)!,
        sourceDocumentId: `${input.id}:earnings.htm`,
        documentKind: 'EARNINGS_RELEASE' as const,
        text: 'Revenue was 10 billion.',
        rawContent: new TextEncoder().encode('raw'),
        contentHash: 'd'.repeat(64),
      });
    },
  };
  const prisma = {
    filing: {
      findFirst: async ({ where }: any) => where.OR?.some((condition: any) => condition.sourceGroupId === 'quarterly-linked') ? { id: 'linked' } : null,
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 'filing-new', ...data }),
    },
    filingDerivation: { upsert: async ({ create }: any) => ({ id: 'derivation-new', ...create }) },
  };
  const prepared = await new EarningsSourceService(prisma as any, port, port).discoverAndIngest(stock);
  assert.equal(prepared.sourceGroupId, 'release-new');
  assert.deepEqual(fetched, ['release-new']);
});

test('parser derivations stay owned by one filing even when content hashes match', () => {
  assert.notEqual(
    buildParserDerivationKey('filing-1', 'a'.repeat(64)),
    buildParserDerivationKey('filing-2', 'a'.repeat(64)),
  );
});

function summary(id: string, filingUrl: string) {
  return {
    id,
    sourceDocumentId: id,
    sourceGroupId: id,
    instrumentId: 'US:NVDA',
    formType: '8-K',
    filingDate: '2026-07-20',
    filingUrl,
    title: 'Current report',
    provider: 'sec-edgar',
    documentKind: 'PRIMARY' as const,
  };
}

function envelope<T>(data: T) {
  return {
    schemaVersion: '1.0' as const,
    data,
    citations: [],
    freshness: [],
    warnings: [],
  };
}
