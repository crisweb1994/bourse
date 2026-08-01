import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderFilingPort as FilingPort } from '@bourse/analysis';
import {
  buildParserDerivationKey,
  EarningsSourceService,
  prioritizeEarningsSources,
} from './earnings-source.service';
import { EarningsSourceError } from './earnings-source.service';
import { FilingStoreService } from '../filings/filing-store.service';

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
  const service = new EarningsSourceService(prisma as any, clientFromPort(port), new FilingStoreService(prisma as any));
  const prepared = await service.discoverAndIngest(stock);
  assert.equal(prepared.sourceDocumentId, 'accession-earnings:earnings.htm');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].documentKind, 'EARNINGS_RELEASE');
});

test('EarningsSourceService requests foreign issuer filing forms for US stocks', async () => {
  let request: any;
  const port: FilingPort = {
    async searchFilings(input) {
      request = input;
      return envelope([]);
    },
  };
  const prisma = { filing: { findFirst: async () => null } } as any;
  const service = new EarningsSourceService(prisma, clientFromPort(port), new FilingStoreService(prisma));

  await assert.rejects(
    () => service.discoverAndIngest({ ...stock, symbol: 'BABA', name: 'Alibaba' }),
    (error: unknown) => error instanceof EarningsSourceError && error.code === 'NO_ELIGIBLE_FILING',
  );
  assert.deepEqual(request.forms, ['8-K', '10-Q', '10-K', '6-K', '20-F']);
  assert.equal(request.limit, 100);
});

test('EarningsSourceService explains OTC/ADR tickers without SEC filings', async () => {
  const port: FilingPort = {
    async searchFilings() {
      return {
        schemaVersion: '1.0' as const,
        data: [],
        citations: [],
        freshness: [],
        warnings: [
          {
            code: 'INVALID_INSTRUMENT' as const,
            message: 'MPNGY is not a US SEC filer (OTC/ADR tickers are not covered by EDGAR)',
            provider: 'sec-edgar',
          },
        ],
      };
    },
  };
  const prisma = { filing: { findFirst: async () => null } } as any;
  const service = new EarningsSourceService(prisma, clientFromPort(port), new FilingStoreService(prisma));

  await assert.rejects(
    () => service.discoverAndIngest({ ...stock, symbol: 'MPNGY', name: 'Meituan' }),
    (error: unknown) => {
      assert.ok(error instanceof EarningsSourceError);
      assert.equal(error.code, 'NO_ELIGIBLE_FILING');
      assert.ok(error.message.includes('OTC/ADR'));
      assert.ok(error.message.includes('03690.HK'));
      return true;
    },
  );
});

test('EarningsSourceService skips a non-earnings 6-K and accepts an earnings 6-K', async () => {
  const summaries = [
    { ...summary('ordinary-6k', 'https://www.sec.gov/Archives/ordinary/main.htm'), formType: '6-K', title: 'Corporate update' },
    { ...summary('results-6k', 'https://www.sec.gov/Archives/results/main.htm'), formType: '6-K', title: 'Financial results' },
  ];
  const fetched: string[] = [];
  const port: FilingPort = {
    async searchFilings() { return envelope(summaries); },
    async getFiling(input) {
      fetched.push(input.id);
      const earnings = input.id === 'results-6k';
      return envelope({
        ...summaries.find((item) => item.id === input.id)!,
        sourceDocumentId: `${input.id}:main.htm`,
        documentKind: earnings ? 'EARNINGS_RELEASE' as const : 'OTHER' as const,
        text: earnings ? 'Financial results. Revenue was $10 billion. Net income was $2 billion.' : 'Corporate update.',
        rawContent: new TextEncoder().encode('raw'),
        contentHash: earnings ? 'f'.repeat(64) : 'e'.repeat(64),
      });
    },
  };
  const prisma = {
    filing: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 'filing-6k', ...data }),
    },
    filingDerivation: { upsert: async ({ create }: any) => ({ id: 'derivation-6k', ...create }) },
  };
  const prepared = await new EarningsSourceService(prisma as any, clientFromPort(port), new FilingStoreService(prisma as any)).discoverAndIngest({ ...stock, symbol: 'BABA', name: 'Alibaba' });
  assert.equal(prepared.formType, '6-K');
  assert.equal(prepared.sourceDocumentId, 'results-6k:main.htm');
  assert.deepEqual(fetched, ['ordinary-6k', 'results-6k']);
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
  const prisma = {
    filing: { findFirst: async () => null },
  } as any;
  const service = new EarningsSourceService(prisma, clientFromPort(port), new FilingStoreService(prisma));

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
  const prepared = await new EarningsSourceService(prisma as any, clientFromPort(port), new FilingStoreService(prisma as any)).discoverAndIngest(stock);
  assert.equal(prepared.sourceGroupId, 'release-new');
  assert.deepEqual(fetched, ['release-new']);
});

test('parser derivations stay owned by one filing even when content hashes match', () => {
  assert.notEqual(
    buildParserDerivationKey('filing-1', 'a'.repeat(64)),
    buildParserDerivationKey('filing-2', 'a'.repeat(64)),
  );
});

test('HK earnings sources prefer preliminary results and English variants', () => {
  const annualGroup = '0700:2026-04-09:annual';
  const preliminaryGroup = '0700:2026-03-18:preliminary';
  const sources = [
    hkSummary('annual-zh', annualGroup, 'annual', 'zh-HK'),
    hkSummary('annual-en', annualGroup, 'annual', 'en-HK'),
    hkSummary('preliminary-zh', preliminaryGroup, 'preliminary', 'zh-HK'),
    hkSummary('preliminary-en', preliminaryGroup, 'preliminary', 'en-HK'),
  ];

  assert.deepEqual(
    prioritizeEarningsSources(sources, 'HK').map((item) => item.sourceDocumentId),
    ['preliminary-en', 'preliminary-zh', 'annual-en', 'annual-zh'],
  );
  assert.deepEqual(prioritizeEarningsSources(sources, 'US'), sources);
});

test('US foreign issuer sources prefer 20-F before frequent 6-K notices', () => {
  const sources = [
    { ...summary('latest-6k', 'https://www.sec.gov/Archives/latest-6k.htm'), formType: '6-K' },
    { ...summary('annual-20f', 'https://www.sec.gov/Archives/annual-20f.htm'), formType: '20-F' },
    { ...summary('prior-6k', 'https://www.sec.gov/Archives/prior-6k.htm'), formType: '6-K' },
  ];
  assert.deepEqual(
    prioritizeEarningsSources(sources, 'US').map((item) => item.sourceDocumentId),
    ['annual-20f', 'latest-6k', 'prior-6k'],
  );
});

test('HK earnings source priority preserves unrelated filing slots', () => {
  const sources = [
    hkSummary('annual-en', 'annual-group', 'annual', 'en-HK'),
    {
      ...hkSummary('quarterly-en', 'quarterly-group', 'preliminary', 'en-HK'),
      formType: 'quarterly',
      periodEndOn: '2026-03-31',
    },
    hkSummary('preliminary-en', 'preliminary-group', 'preliminary', 'en-HK'),
  ];

  assert.deepEqual(
    prioritizeEarningsSources(sources, 'HK').map((item) => item.sourceDocumentId),
    ['preliminary-en', 'quarterly-en', 'annual-en'],
  );
});

test('EarningsSourceService does not fetch an excluded source group', async () => {
  const excludedGroup = '0700:2026-04-09:annual';
  const allowedGroup = '0700:2026-03-18:preliminary';
  const summaries = [
    hkSummary('annual-en', excludedGroup, 'annual', 'en-HK'),
    hkSummary('preliminary-en', allowedGroup, 'preliminary', 'en-HK'),
  ];
  const fetched: string[] = [];
  const port: FilingPort = {
    async searchFilings() { return envelope(summaries); },
    async getFiling(input) {
      fetched.push(input.sourceDocumentId ?? input.id);
      return envelope({
        ...summaries.find((item) => item.sourceDocumentId === input.sourceDocumentId)!,
        text: undefined,
        rawContent: new Uint8Array([1]),
        contentHash: 'e'.repeat(64),
      });
    },
  };
  const prisma = { filing: { findFirst: async () => null } } as any;
  const service = new EarningsSourceService(prisma, clientFromPort(port), new FilingStoreService(prisma));

  await assert.rejects(
    () => service.discoverAndIngest(
      { ...stock, symbol: '0700', market: 'HK', exchange: 'HKEX', currency: 'HKD' },
      { excludedSourceGroupIds: [excludedGroup] },
    ),
    (error: unknown) => error instanceof EarningsSourceError && error.code === 'BODY_UNREADABLE',
  );
  assert.deepEqual(fetched, ['preliminary-en']);
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

function hkSummary(
  sourceDocumentId: string,
  sourceGroupId: string,
  formType: 'annual' | 'preliminary',
  language: 'zh-HK' | 'en-HK',
) {
  return {
    id: sourceDocumentId,
    sourceDocumentId,
    sourceGroupId,
    instrumentId: 'HK:0700',
    formType,
    filingDate: formType === 'annual' ? '2026-04-09' : '2026-03-18',
    periodEndOn: '2025-12-31',
    filingUrl: `https://www1.hkexnews.hk/${sourceDocumentId}.pdf`,
    title: formType === 'annual'
      ? 'ANNUAL REPORT 2025'
      : 'ANNOUNCEMENT OF THE ANNUAL RESULTS FOR THE YEAR ENDED 31 DECEMBER 2025',
    provider: 'hkex',
    language,
    documentKind: 'PDF' as const,
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

function clientFromPort(port: FilingPort): any {
  return {
    listFilings: async (input: any, ctx?: any) => v2(await port.searchFilings(input, ctx)),
    getFilingDocument: async (input: any, ctx?: any) => {
      if (!port.getFiling) throw new Error('missing getFiling');
      return v2(await port.getFiling(input, ctx));
    },
  };
}

function v2<T>(result: {
  data: T;
  citations: any[];
  freshness: any[];
  warnings: any[];
}) {
  return {
    ...result,
    schemaVersion: '2.0' as const,
    status: 'ok' as const,
    trace: { attempts: [] },
  };
}
