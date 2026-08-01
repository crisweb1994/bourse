/**
 * earnings v2 实网冒烟：对给定 instrument 跑 v2 connector + selector。
 *
 * 用法：
 *   pnpm --filter @bourse/api exec tsx scripts/earnings-v2-smoke.ts [US:AAPL CN:600519 HK:00700 ...]
 *
 * 默认目标：US:AAPL US:MSFT CN:600519 HK:00700 HK:09988。
 * 只读操作；SEC 请求遵循 fair access（默认 UA bourance + bourance.gmail.com）。
 */
import { projectStructuredEarnings } from '@bourse/analysis';
import { buildV2FinancialsConnector } from '../src/earnings/earnings-v2-runner.service';

const targets =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['US:AAPL', 'US:MSFT', 'CN:600519', 'HK:00700', 'HK:09988'];

async function main(): Promise<void> {
  const now = new Date().toISOString();
  for (const instrumentId of targets) {
    const separator = instrumentId.indexOf(':');
    if (separator <= 0) {
      console.log(`${instrumentId}\tinvalid instrument (expected MARKET:SYMBOL)`);
      continue;
    }
    const market = instrumentId.slice(0, separator);
    const connector = buildV2FinancialsConnector(market);
    if (!connector) {
      console.log(`${instrumentId}\tNO_CONNECTOR`);
      continue;
    }
    try {
      const result = await connector.fetchFinancials({ instrumentId, deriveTTM: false });
      if (!result.data) {
        console.log(
          `${instrumentId}\tNO_DATA\t${result.warnings.map((w) => `${w.code}:${w.message}`).join(' | ')}`,
        );
        continue;
      }
      const bundle = result.data;
      const target = bundle.periods.find((period) => period.fiscalPeriodType === 'FY') ?? bundle.periods[0];
      if (!target) {
        console.log(`${instrumentId}\tNO_PERIODS`);
        continue;
      }
      const expectedPeriodType =
        target.fiscalPeriodType === 'H1' || target.fiscalPeriodType === '9M'
          ? target.fiscalPeriodType
          : target.fiscalPeriodType === 'Q1' || target.fiscalPeriodType === 'Q2' || target.fiscalPeriodType === 'Q3'
            ? target.fiscalPeriodType
            : 'FY';
      const selection = projectStructuredEarnings({
        bundle,
        market: market as 'US' | 'CN' | 'HK',
        expectedInstrumentId: instrumentId,
        expectedPeriodEndOn: target.periodEndOn,
        expectedPeriodType,
        expectedFiscalYear: target.fiscalYear,
        eventPublishedAt: now,
        knowledgeCutoffAt: now,
        now,
      });
      const facts =
        selection.status === 'ready' || selection.status === 'ambiguous'
          ? selection.facts
              .map((fact) => {
                const value = fact.normalizedValue ?? fact.value;
                return `${fact.metricCode}=${value.kind === 'scalar' ? value.value : `${value.min}~${value.max}`}`;
              })
              .join(',')
          : '';
      console.log(
        `${instrumentId}\tperiods=${bundle.periods.map((p) => `${p.fiscalPeriodType}@${p.periodEndOn}`).join(',')}\t` +
          `selection=${selection.status}${selection.status === 'ready' ? ` period=${selection.period.id}` : ''}` +
          (selection.status === 'pending' ? ` reason=${selection.reason}` : '') +
          (facts ? ` facts=[${facts}]` : ''),
      );
    } catch (error) {
      console.log(`${instrumentId}\tERROR\t${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

void main();
