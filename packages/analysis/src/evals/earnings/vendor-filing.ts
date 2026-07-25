/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCnFilingsConnector } from '../../connectors/filings/cn';
import { createSecEdgarFilingsConnector } from '../../connectors/filings/sec-edgar';
import type { FilingPort } from '../../ports/filings';

interface Args {
  market: 'US' | 'CN';
  symbol: string;
  outDir: string;
  form?: string;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const port: FilingPort = args.market === 'US'
    ? createSecEdgarFilingsConnector({
        userAgent: process.env.RESEARCH_CORE_USER_AGENT?.trim() || 'Bourse earnings eval contact@example.com',
      })
    : createCnFilingsConnector();
  const forms = args.form ? [args.form] : args.market === 'US'
    ? ['8-K', '10-Q', '10-K']
    : ['preview', 'preliminary', 'quarterly', 'semiannual', 'annual'];
  const listed = await port.searchFilings({ instrumentId: `${args.market}:${args.symbol}`, forms, limit: 12 });
  if (listed.data.length === 0) throw new Error(listed.warnings.map((warning) => warning.message).join('; ') || 'no filing');
  for (const summary of listed.data) {
    const result = await port.getFiling?.(summary);
    if (!result?.data.text || !result.data.contentHash) continue;
    if (args.market === 'US' && summary.formType.toUpperCase() === '8-K' && result.data.documentKind !== 'EARNINGS_RELEASE') continue;
    mkdirSync(args.outDir, { recursive: true });
    const filename = `${args.market}_${args.symbol}_${summary.formType.replace(/[^a-z0-9]+/gi, '-')}_${summary.filingDate.slice(0, 10)}.json`;
    const payload = {
      vendoredAt: new Date().toISOString(),
      summary,
      document: {
        sourceDocumentId: result.data.sourceDocumentId,
        sourceGroupId: result.data.sourceGroupId,
        sourceUrl: result.data.filingUrl,
        provider: result.data.provider,
        contentHash: result.data.contentHash,
        text: result.data.text,
        pages: result.data.pages,
      },
      warnings: [...listed.warnings, ...result.warnings],
    };
    const path = join(args.outDir, filename);
    writeFileSync(path, JSON.stringify(payload, null, 2));
    console.log(path);
    return;
  }
  throw new Error('no readable filing in search window');
}

function parse(argv: string[]): Args {
  argv = argv.filter((value) => value !== '--');
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? '', argv[index + 1] ?? '');
  }
  const market = values.get('--market');
  const symbol = values.get('--symbol');
  if ((market !== 'US' && market !== 'CN') || !symbol) {
    throw new Error('usage: --market US|CN --symbol SYMBOL [--out DIR]');
  }
  return {
    market,
    symbol,
    outDir: values.get('--out') || '/tmp/bourse-earnings-eval',
    ...(values.get('--form') ? { form: values.get('--form') } : {}),
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
