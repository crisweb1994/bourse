/* eslint-disable no-console */
import { createMarketData, type ResearchResult } from '../src';

type SupportedMarket = 'US' | 'CN' | 'HK';

const requested = process.argv.slice(2).filter((value) => value !== '--');
const instruments = requested.length > 0
  ? requested
  : ['US:AAPL', 'HK:0700', 'CN:600519'];

const client = createMarketData({
  secUserAgent: process.env.RESEARCH_CORE_USER_AGENT,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY,
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
  eodhdApiKey: process.env.EODHD_API_KEY,
});

async function main(): Promise<void> {
  for (const instrumentId of instruments) {
    const market = parseMarket(instrumentId);
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
    const from = fromDate.toISOString().slice(0, 10);

    console.log(`\n${instrumentId}`);
    await probe('quote', () => client.getQuote(instrumentId));
    await probe('history', () => client.getHistory({ instrumentId, from, to, interval: '1d' }));
    await probe('profile', () => client.getProfile(instrumentId));
    await probe('financials', () => client.getFinancials(instrumentId, { timeoutMs: 20_000 }));
    await probe('filings', () => client.getFilings(instrumentId, 5));
    await probe('macro', () => client.getMacro(market));
    await probeList('instruments', () => client.searchInstruments(instrumentId.split(':')[1] ?? instrumentId));
  }

  if (client.hasSearchProvider) {
    await probe('web-search', () => {
      const result = client.searchWeb({
        query: 'Apple AAPL latest investor relations earnings',
        limit: 3,
      });
      if (!result) throw new Error('Web search provider is not configured.');
      return result;
    });
  } else {
    console.log('\nweb-search SKIP provider=none reason=TAVILY_API_KEY_not_configured');
  }
}

void main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

function parseMarket(instrumentId: string): SupportedMarket {
  const market = instrumentId.split(':', 1)[0];
  if (market === 'US' || market === 'CN' || market === 'HK') return market;
  throw new Error(`Expected instrument id such as US:AAPL, HK:0700, or CN:600519; got ${instrumentId}`);
}

async function probe(
  kind: string,
  call: () => Promise<ResearchResult<unknown>>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await call();
    const provider = [...new Set([
      ...result.citations.map((citation) => citation.provider),
      ...result.freshness.map((freshness) => freshness.provider),
    ].filter(Boolean))].join('+') || 'none';
    const asOf = result.freshness[0]?.asOf ?? 'unknown';
    const available = hasData(result.data);
    const warnings = [...new Set(result.warnings.map((warning) => warning.code))];
    console.log(
      `${kind.padEnd(10)} ${available ? 'OK  ' : 'MISS'} provider=${provider} asOf=${asOf} durationMs=${Date.now() - startedAt} warnings=${warnings.join(',') || 'none'}`,
    );
  } catch (error) {
    console.log(
      `${kind.padEnd(10)} FAIL provider=none asOf=unknown durationMs=${Date.now() - startedAt} error=${safeError(error)}`,
    );
  }
}

async function probeList(
  kind: string,
  call: () => Promise<unknown[]>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await call();
    console.log(
      `${kind.padEnd(10)} ${result.length > 0 ? 'OK  ' : 'MISS'} count=${result.length} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    console.log(
      `${kind.padEnd(10)} FAIL count=0 durationMs=${Date.now() - startedAt} error=${safeError(error)}`,
    );
  }
}

function hasData(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.periods)) return record.periods.length > 0;
    if (Array.isArray(record.observations)) return record.observations.length > 0;
  }
  return true;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 160);
}
