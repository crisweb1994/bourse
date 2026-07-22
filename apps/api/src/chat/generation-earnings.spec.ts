import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGenerationService } from './generation.service';

function service() {
  return new ChatGenerationService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

test('chat routes earnings intent before open research', () => {
  const intent = (service() as any).routeIntent(
    '最新财报里营收变化是什么？',
    undefined,
    { action: 'MAINTAIN' },
  );
  assert.equal(intent, 'EARNINGS_BRIEF');
});

test('earnings chat sources retain immutable revision and fact provenance', () => {
  const sources = (service() as any).buildEarningsSources({
    revisionId: 'revision-1',
    name: 'Apple',
    fiscalYear: 2026,
    periodType: 'Q2',
    filing: { publishedAt: '2026-07-20T00:00:00.000Z' },
    generatedAt: '2026-07-20T00:01:00.000Z',
    facts: [{
      metricCode: 'revenue',
      value: { kind: 'scalar', value: '100' },
      unit: 'currency',
      checkStatus: 'passed',
      reconcileStatus: { status: 'pending' },
      comparisons: [],
      provenance: {
        kind: 'filingSpan',
        sourceUrl: 'https://example.com/filing',
        provider: 'fixture',
        quote: 'Revenue was 100.',
      },
    }],
    managementClaims: [],
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'earnings-source-0');
  assert.equal(sources[0].revisionId, 'revision-1');
  assert.match(sources[0].snippet, /Revenue was 100/);
});

test('earnings chat adds selected long-filing sections to the same immutable revision', () => {
  const sources = (service() as any).buildEarningsSources({
    revisionId: 'revision-1',
    name: 'Apple',
    fiscalYear: 2026,
    periodType: 'Q2',
    filing: { publishedAt: '2026-07-20T00:00:00.000Z' },
    generatedAt: '2026-07-20T00:01:00.000Z',
    facts: [],
    managementClaims: [],
  }, [{
    title: 'Liquidity and Capital Resources',
    text: 'Operating cash flow increased.',
    sourceUrl: 'https://example.com/10q',
    provider: 'sec-edgar',
    filingId: 'filing-10q',
    derivationId: 'derivation-10q',
    contentHash: 'a'.repeat(64),
    startOffset: 100,
    endOffset: 200,
  }]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0].revisionId, 'revision-1');
  assert.match(sources[0].snippet, /Operating cash flow increased/);
  assert.match(sources[0].snippet, /derivation-10q/);
});
