import { createHash } from 'node:crypto';
import { RESEARCH_SCHEMA_VERSION, type ResearchResult } from '../../contracts/result';
import type { ProviderFilingPort, FilingSummary } from '../../ports/filings';
import type { ProviderCorporateActionsPort, CorporateAction } from '../../ports/corporate-actions';
import type { ProviderMarketEventsPort, MarketEvent } from '../../ports/market-events';

const PROVIDER = 'hkex-filings-derived-events';

export function createHkexDerivedCorporateActionsConnector(filings: ProviderFilingPort): ProviderCorporateActionsPort {
  return {
    async listActions(input, ctx) {
      const result = await filings.searchFilings({ instrumentId: input.instrumentId, from: input.from, to: input.to, limit: Math.min(input.limit ?? 40, 40) }, ctx);
      const data = result.data.flatMap((filing) => toCorporateAction(filing, input.dataSet)).filter((item): item is CorporateAction => Boolean(item));
      return derived(result, data);
    },
  };
}

export function createHkexDerivedMarketEventsConnector(filings: ProviderFilingPort): ProviderMarketEventsPort {
  return {
    async listEvents(input, ctx) {
      const result = await filings.searchFilings({ instrumentId: input.instrumentId, from: input.from, to: input.to, limit: Math.min(input.limit ?? 40, 40) }, ctx);
      const data = result.data.flatMap((filing) => toMarketEvent(filing, input.dataSet)).filter((item): item is MarketEvent => Boolean(item));
      return derived(result, data);
    },
  };
}

function toCorporateAction(filing: FilingSummary, requested: string): CorporateAction | null {
  const title = filing.title ?? '';
  const mapping: Array<{ dataSet: string; pattern: RegExp; type: CorporateAction['type'] }> = [
    { dataSet: 'dividend', pattern: /dividend|distribution|派息|股息|分派/i, type: 'DIVIDEND' },
    { dataSet: 'rights-issue', pattern: /rights issue|open offer|供股|公開發售/i, type: 'RIGHTS_ISSUE' },
    { dataSet: 'placement', pattern: /placing|placement|配售|配股/i, type: 'PLACEMENT' },
    { dataSet: 'buyback', pattern: /repurchase|buy-?back|回購/i, type: 'BUYBACK' },
    { dataSet: 'split', pattern: /share subdivision|share consolidation|股份拆細|股份合併/i, type: 'SPLIT' },
  ];
  const match = mapping.find((item) => item.dataSet === requested && item.pattern.test(title));
  if (!match) return null;
  return { id: idFor(filing, requested), instrumentId: filing.instrumentId, type: match.type, status: 'ANNOUNCED', announcedAt: filing.filingDate, sourceDocumentId: filing.sourceDocumentId };
}

function toMarketEvent(filing: FilingSummary, requested: string): MarketEvent | null {
  const title = filing.title ?? '';
  if (requested === 'suspension' && /suspension|halt|停牌/i.test(title)) return generic(filing, 'SUSPENSION');
  if (requested === 'suspension' && /resumption|復牌/i.test(title)) return generic(filing, 'RESUMPTION');
  if (requested === 'earnings-guidance' && /profit warning|profit alert|盈警|盈利警告|盈喜/i.test(title)) return generic(filing, 'EARNINGS_GUIDANCE');
  if (requested === 'regulatory-event' && /inside information|notifiable transaction|regulatory|內幕消息|須予公布/i.test(title)) return generic(filing, 'REGULATORY_EVENT');
  return null;
}

function generic(filing: FilingSummary, type: 'SUSPENSION' | 'RESUMPTION' | 'EARNINGS_GUIDANCE' | 'REGULATORY_EVENT'): MarketEvent {
  return { id: idFor(filing, type), instrumentId: filing.instrumentId, type, occurredAt: filing.filingDate, title: filing.title ?? type, sourceDocumentId: filing.sourceDocumentId };
}

function derived<T>(upstream: ResearchResult<unknown>, data: T): ResearchResult<T> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data, citations: upstream.citations.map((citation) => ({ ...citation, provider: PROVIDER, qualityTier: 'A' })), freshness: upstream.freshness.map((item) => ({ ...item, provider: PROVIDER })), warnings: upstream.warnings };
}
function idFor(filing: FilingSummary, kind: string) { return `${PROVIDER}:${createHash('sha1').update(`${filing.sourceDocumentId}:${kind}`).digest('hex').slice(0, 16)}`; }
