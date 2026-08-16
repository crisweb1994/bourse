/* eslint-disable no-console */
/**
 * 可视化方案取数验证脚本（PRD docs/visualization-prd.md 的实证）。
 * 逐图（C1/C2/C3/C5/C10/C11）验证：demo 中使用的每个字段能否由真实
 * market-data 连接器 + compute 计算层实际产出。不使用任何 mock。
 *
 * 运行：cd packages/analysis && pnpm tsx scripts/verify-chart-data.ts [US:AAPL] [CN:600519]
 */
import {
  createMarketData,
  derivePriceSeries,
  computeTechnicalIndicators,
  computeValuation,
  computeFinancialRatios,
  type PriceBar,
  type Quote,
  type FinancialsBundle,
} from '../src';

const client = createMarketData({
  secUserAgent: process.env.RESEARCH_CORE_USER_AGENT,
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY,
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
  eodhdApiKey: process.env.EODHD_API_KEY,
});

const args = process.argv.slice(2);
const usId = args.find((a) => a.startsWith('US:')) ?? 'US:AAPL';
const cnId = args.find((a) => a.startsWith('CN:')) ?? 'CN:600519';

const ok = (s: string) => `✔ ${s}`;
const bad = (s: string) => `✘ ${s}`;
function providerOf(r: { citations?: Array<{ provider?: string }>; trace?: { selectedSource?: string } }): string {
  const p = r.citations?.[0]?.provider ?? r.trace?.selectedSource ?? 'unknown';
  const url = (r.citations?.[0] as { url?: string } | undefined)?.url ?? '';
  return `${p}${url ? ` (${url.slice(0, 60)})` : ''}`;
}
const n = (v: number | null | undefined, d = 2) => (v == null || Number.isNaN(v) ? 'null' : v.toFixed(d));

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.log(bad(`${label} 异常: ${(e as Error).message.slice(0, 140)}`));
    return null;
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`① ${usId} · 行情与 K 线（C1 数据源）`);
  console.log('══════════════════════════════════════════════════════════════');
  const quoteRes = await safe('getQuote', () => client.getQuote(usId, { timeoutMs: 10_000 }));
  const quote: Quote | null = quoteRes?.data ?? null;
  if (quote) {
    console.log(ok(`quote.price=${n(quote.price)} changePct=${n(quote.changePct)} marketCap=${quote.marketCap ?? 'null'} pe=${quote.peRatio ?? 'null'} asOf=${quote.asOf ?? '?'}`));
    console.log(`   来源: ${providerOf(quoteRes!)}`);
  } else console.log(bad('quote 获取失败'));

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const histRes = await safe('getHistory', () => client.getHistory({ instrumentId: usId, from, to, interval: '1d' }, { timeoutMs: 15_000 }));
  const bars: PriceBar[] = histRes?.data ?? [];
  if (bars.length > 0) {
    const last = bars[bars.length - 1]!;
    console.log(ok(`history.bars=${bars.length} 根 (${bars[0]!.timestamp} → ${last.timestamp}) lastClose=${n(last.close)} lastVolume=${last.volume ?? 'null'}`));
    console.log(`   来源: ${providerOf(histRes!)}`);
    const sourceTier = histRes?.citations?.find((citation) => citation.qualityTier)?.qualityTier ?? 'B';
    const priceSeries = derivePriceSeries(bars, sourceTier);
    console.log(ok(`priceSeries=${priceSeries?.bars.length ?? 0} 根 basis=${priceSeries?.basis ?? 'null'} asOf=${priceSeries?.asOf ?? 'null'} — 可持久化到 EvidencePack`));
  } else console.log(bad('history 获取失败'));

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`② ${usId} · computeTechnicalIndicators（C1 支撑阻力/均线/RSI）`);
  console.log('──────────────────────────────────────────────────────────────');
  const tech = computeTechnicalIndicators({ bars });
  const t = tech.indicators;
  if (t) {
    console.log(ok(`sma20=${n(t.sma20)} sma50=${n(t.sma50)} sma200=${n(t.sma200)} rsi14=${n(t.rsi14)}`));
    console.log(ok(`nearestSupport=${n(t.nearestSupport)} nearestResistance=${n(t.nearestResistance)} ← C1 标注线`));
    console.log(ok(`trend=${t.trend} momentum=${t.momentum} obvTrend=${t.obvTrend} volumeVs20dAvg=${n(t.volumeVs20dAvg)}`));
    const keys = Object.keys(t).join(',');
    console.log(`   ▸ 字段清单: ${keys}`);
    console.log(`   ▸ PRD §6.2 实证：${keys.includes('series') ? '已含 series' : '无 series 字段（SMA 序列算完即弃，需按 §6.2 导出）'}`);
  } else console.log(bad(`technical=null (${tech.warnings.map((w) => w.code).join(',') || 'no warning'})`));

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`③ ${usId} · getFinancials → compute 层（C2 PE 带 / C5 财务趋势 / C3 隐含增长）`);
  console.log('──────────────────────────────────────────────────────────────');
  const finRes = await safe('getFinancials', () => client.getFinancials(usId, { timeoutMs: 25_000 }));
  const bundle: FinancialsBundle | null = finRes?.data ?? null;
  if (bundle) {
    console.log(ok(`financials.periods=${bundle.periods.length} 个 (${bundle.periods.map((p) => p.period).slice(0, 6).join(', ')}…) currency=${bundle.currency}`));
    console.log(`   来源: ${providerOf(finRes!)}`);
    const ratios = computeFinancialRatios({ bundle, quote, market: 'US' });
    if (ratios.ratios?.periodTrends?.length) {
      const pt = ratios.ratios.periodTrends;
      const last = pt[pt.length - 1]!;
      console.log(ok(`periodTrends: ${pt.length} 期，最新 ${last.period} revenue=${n(last.revenue, 1)} netIncome=${n(last.netIncome, 1)} grossMargin=${n(last.grossMargin != null ? last.grossMargin * 100 : null)}% netMargin=${n(last.netMargin != null ? last.netMargin * 100 : null)}%  ← C5`));
    } else console.log(bad('periodTrends=null'));
    const val = computeValuation({ bundle, quote, history: bars, market: 'US' });
    const v = val.valuation;
    if (v) {
      if (v.peHistorySeries?.length) {
        console.log(ok(`peHistorySeries: ${v.peHistorySeries.length} 点 → ${v.peHistorySeries.map((p) => `${p.period}:${n(p.pe, 1)}`).join(' ')}  ← C2`));
        console.log(ok(`pe5yHigh=${n(v.pe5yHigh, 1)} pe5yLow=${n(v.pe5yLow, 1)} pe5yMedian=${n(v.pe5yMedian, 1)} pe5yPercentile=${v.pe5yPercentile ?? 'null'}`));
      } else console.log(bad(`peHistorySeries 空 (${val.warnings.map((w) => w.code).join(',') || '-'})`));
      console.log(ok(`reverseDCF.impliedGrowthRate=${v.impliedGrowthRate != null ? (v.impliedGrowthRate * 100).toFixed(1) + '%' : 'null'} fairValue=${n(v.fairValuePerShare)} upside=${v.upside != null ? (v.upside * 100).toFixed(1) + '%' : 'null'} ← C3 标注`));
      console.log(`   DCF 假设: ${JSON.stringify(v.impliedGrowthAssumptions)}`);
    } else console.log(bad('valuation=null'));
  } else console.log(bad('financials 获取失败'));

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`④ ${cnId} · CN 专有 facts（C10 北向 / C11 解禁）`);
  console.log('══════════════════════════════════════════════════════════════');
  const nbRes = await safe('getOwnership(stock-connect)', () =>
    client.getOwnership({ instrumentId: cnId, dataSet: 'stock-connect', limit: 10 }, { timeoutMs: 15_000 }));
  const nb = nbRes?.data ?? [];
  if (nb.length) {
    const hold = nb.filter((o) => o.kind === 'STOCK_CONNECT') as Array<{ asOf: string; holdingPercentOfFloat?: string | null; holdingShares?: string | null; netFlow?: unknown }>;
    const rowsDesc = hold.slice(0, 3);
    if (hold.length && hold[0]?.holdingPercentOfFloat != null) {
      console.log(ok(`北向持股(STOCK_CONNECT 含 holdPctOfFloat) ${hold.length} 行，最近 3 行: ${rowsDesc.map((r) => `${r.asOf}:${r.holdingPercentOfFloat}%`).join(' ')}  ← C10（免费源，无需 Tushare）`));
    } else {
      console.log(`⚠️ 北向观察 ${nb.length} 行（kind=${[...new Set(nb.map((o) => (o as { kind: string }).kind))].join(',')}），但 holdingPercentOfFloat 缺失`);
    }
    console.log(`   来源: ${providerOf(nbRes!)}`);
  } else console.log(bad(`北向持股无数据 (${nbRes?.warnings.map((w) => w.code).join(',') || 'empty'})`));

  const ulId = args.find((a) => a.startsWith('CN:') && a !== cnId) ?? 'CN:301498';
  const ulRes = await safe('getMarketEvents(unlock)', () =>
    client.getMarketEvents({ instrumentId: ulId, dataSet: 'unlock', limit: 6 }, { timeoutMs: 15_000 }));
  const ul = ulRes?.data ?? [];
  if (ul.length) {
    console.log(ok(`[${ulId}] 解禁事件 ${ul.length} 条: ${ul.slice(0, 3).map((e) => `${(e as { occurredAt?: string }).occurredAt?.slice(0, 10) ?? '?'}(${(e as { unlockType?: string }).unlockType ?? '?'} ${(e as { marketValue?: string }).marketValue ?? ''}亿)`).join(' ')}  ← C11（免费源，无需 Tushare）`));
    console.log(`   来源: ${providerOf(ulRes!)}`);
  } else {
    console.log(`⚠️ [${ulId}] 解禁 0 条 (${ulRes?.warnings.map((w) => w.code).join(',') || 'empty'}) — 注意：成熟股票无待解禁时为合法空结果`);
  }

  console.log('');
  console.log('完成：以上全部为真实连接器 + 真实计算输出。');
}

void main().catch((e) => { console.error(e); process.exitCode = 1; });
