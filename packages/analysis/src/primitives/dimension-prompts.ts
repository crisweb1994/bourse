import type { StructuredJson } from '../contracts/analysis-result';
import type { EvidencePackV2 } from '../contracts/evidence-pack-v2';

/**
 * RFC-02 §13: Format an EvidencePack v2 as a Chinese-language prompt block
 * to prepend to a dimension's system prompt. The block tells the LLM which
 * facts have already been verified by code (so it should not re-search them)
 * and which facts were unavailable (so it must not hallucinate them).
 *
 * Design:
 * - One line per populated fact, value + provenance summary.
 * - Long arrays/objects truncated at 500 chars JSON-stringified.
 * - Missing facts list (when non-empty) explains why each is missing.
 * - Trailing rules: prefer pack values, never re-search, output
 *   `factReferences[]` listing which fact keys were used.
 *
 * Pure function — no IO, deterministic given input.
 */
export function formatEvidencePackBlock(
  pack: EvidencePackV2,
): string {
  const lines: string[] = [];
  lines.push('【事实包 (EvidencePack v2)】');
  lines.push(
    `目标: ${pack.symbol} (${pack.market})  采集于 ${pack.capturedAt}`,
  );

  // v0.6 PRD §9.2 + §10.2 — systemContext is the single source of truth for
  // plan-derived prompt constraints (cap / blockedClaims / skippedSlots /
  // disclaimer). When present, render BEFORE the facts block so the LLM
  // sees the constraints before consuming facts.
  if (pack.systemContext) {
    lines.push('');
    lines.push(formatSystemContextBlock(pack.systemContext));
  }

  lines.push('');
  lines.push(
    '以下事实由 TS 代码从 A 股权威/主流数据源直接拉取，已通过 sourceTier 分级和 provenance 校验。你的分析必须优先引用这些值，不要为这些字段重新发起 web_search：',
  );
  lines.push('');

  // Stable iteration order — matches EvidencePackV2 schema field order.
  const factOrder = [
    'quote',
    'marketCap',
    'currency',
    'pe',
    'latestFilingUrls',
    'recentNews',
    'consensusEps',
    'peHistoricalPercentile',
    'northboundFlow',
    'lhbAppearances',
    'unlockCalendar',
    'shareholderConcentration',
    'financials',
  ] as const;

  for (const key of factOrder) {
    const fact = pack.facts[key as keyof typeof pack.facts];
    if (!fact) continue;
    // RFC financials Phase 1: financials 嵌套结构，特殊渲染（默认 JSON.stringify
    // 会把 5 期三表打成几千字符）
    if (key === 'financials') {
      lines.push(...formatFinancialsBlock(fact));
      continue;
    }
    const valueStr = formatFactValue(fact.value);
    const unit = fact.unit ? ` ${fact.unit}` : '';
    const provenance = [
      `asOf=${fact.asOf.slice(0, 10)}`,
      `retrievedAt=${fact.retrievedAt.slice(0, 16)}Z`,
      `tier=${fact.sourceTier}`,
      `source=${shortHost(fact.sourceUrl)}`,
    ].join(' ');
    lines.push(`- ${key}: ${valueStr}${unit}  [${provenance}]`);
  }

  // plan-v2 Wave 1 — pre-computed deterministic block. Rendered AFTER raw
  // facts so the LLM associates the numbers with their source, but BEFORE
  // the citation rules so it's clear these are first-class.
  if (pack.computedFacts) {
    lines.push('');
    lines.push(...formatComputedFactsBlock(pack.computedFacts));
  }

  if (pack.dataAvailability.missing.length > 0) {
    // Split the missing set: a genuinely-FAILED fetch (connector_error /
    // rate_limited / timeout …) is worth a web_search; a field that is
    // structurally absent for this market (`not_configured` — never wired, or
    // N/A like CN-only signals on a US stock) is NOT — inviting search for it
    // just burns calls. Only the failed group gets the gap-fill invitation.
    const isStructurallyAbsent = (reason: string): boolean =>
      reason.startsWith('not_configured');
    const searchable = pack.dataAvailability.missing.filter(
      (m) => !isStructurallyAbsent(m.reason),
    );
    const unavailable = pack.dataAvailability.missing.filter((m) =>
      isStructurallyAbsent(m.reason),
    );
    if (searchable.length > 0) {
      lines.push('');
      lines.push(
        '【数据缺失·可补充】以下字段抓取失败。你可以用 web_search 自主补充；补来的每个数值必须紧跟标注来源 URL 与日期，并注明 "(网搜补充·未经代码核验)"，禁止凭 prior knowledge 编造，且不得用于覆盖上方已有的代码核验值：',
      );
      for (const m of searchable) lines.push(`- ${m.field}: ${m.reason}`);
    }
    if (unavailable.length > 0) {
      lines.push('');
      lines.push(
        '【数据缺失·本市场不适用】以下字段对该标的/市场不适用或未接入，无需 web_search；如分析中提及，标注 "数据缺失" 即可，禁止编造：',
      );
      for (const m of unavailable) lines.push(`- ${m.field}: ${m.reason}`);
    }
  }

  lines.push('');
  lines.push('【引用规则】');
  lines.push(
    '- 数字字段优先引用 EvidencePack 内值；仅当某字段列在上方"数据缺失·可补充"中时，方可用 web_search 补充并按"(网搜补充·未经代码核验)"标注来源；已在事实包中、或标"本市场不适用"的字段不要 web_search',
  );
  if (pack.computedFacts) {
    lines.push(
      '- 比率 / 技术指标 / 红旗已由 TS 代码确定性计算，直接引用 "【已计算指标】" 块的数值，禁止重新推导 (ROE / 毛利率 / PE 等不要让 LLM 自己算)',
    );
  }
  lines.push(
    '- structuredJson 应输出 factReferences[] 字段，列出本节实际引用的 fact key（如 ["quote", "pe", "consensusEps"]），未引用任何字段时省略',
  );

  return lines.join('\n');
}

/**
 * plan-v2 Wave 1 — render the deterministic compute block into prompt text.
 *
 * Design notes:
 * - Numbers come pre-normalized in base currency / pure ratios; no scaling
 *   applied here.
 * - Null fields are silently omitted (we don't want to broadcast "PE: null"
 *   as if it were a finding).
 * - Period trends are limited to the latest 5 entries — enough trajectory
 *   without bloating the prompt.
 */
function formatComputedFactsBlock(block: import('../contracts/evidence-pack-v2').ComputedFactsBlock): string[] {
  const lines: string[] = [];
  lines.push(
    '【已计算指标】以下数值由 TypeScript 代码从结构化数据确定性计算，必须直接引用，禁止重算：',
  );

  const r = block.ratios;
  if (r) {
    lines.push(`基础货币: ${r.baseCurrency}  ｜  计算时刻: ${r.computedAt.slice(0, 19)}Z`);
    const valuation = compact([
      r.pe !== null ? `PE=${r.pe.toFixed(2)}` : null,
      r.pb !== null ? `PB=${r.pb.toFixed(2)}` : null,
      r.ps !== null ? `PS=${r.ps.toFixed(2)}` : null,
      r.fcfYield !== null ? `FCFYield=${formatPct(r.fcfYield)}` : null,
      r.evToEbitda !== null ? `EV/EBITDA=${r.evToEbitda.toFixed(2)}` : null,
    ]);
    if (valuation.length) lines.push(`  估值: ${valuation.join(' ｜ ')}`);

    const profitability = compact([
      r.grossMargin !== null ? `毛利率=${formatPct(r.grossMargin)}` : null,
      r.operatingMargin !== null ? `营业利润率=${formatPct(r.operatingMargin)}` : null,
      r.netMargin !== null ? `净利率=${formatPct(r.netMargin)}` : null,
      r.roe !== null ? `ROE=${formatPct(r.roe)}` : null,
      r.roic !== null ? `ROIC=${formatPct(r.roic)}` : null,
      r.cashConversionRatio !== null
        ? `现金转换率=${formatPct(r.cashConversionRatio)}`
        : null,
      r.accrualRatio !== null ? `应计比率=${r.accrualRatio.toFixed(4)}` : null,
    ]);
    if (profitability.length) lines.push(`  盈利能力: ${profitability.join(' ｜ ')}`);

    const leverage = compact([
      r.debtToEquity !== null ? `D/E=${r.debtToEquity.toFixed(2)}` : null,
    ]);
    if (leverage.length) lines.push(`  杠杆: ${leverage.join(' ｜ ')}`);

    const growth = compact([
      r.revenueGrowthYoY !== null ? `营收YoY=${formatPct(r.revenueGrowthYoY)}` : null,
      r.earningsGrowthYoY !== null ? `净利YoY=${formatPct(r.earningsGrowthYoY)}` : null,
      r.revenueCagr3y !== null ? `营收3yCAGR=${formatPct(r.revenueCagr3y)}` : null,
      r.fcfCagr3y !== null ? `FCF3yCAGR=${formatPct(r.fcfCagr3y)}` : null,
    ]);
    if (growth.length) lines.push(`  增长: ${growth.join(' ｜ ')}`);

    const trends = r.periodTrends.slice(0, 5);
    if (trends.length > 0) {
      lines.push(`  每期序列 (最近 ${trends.length} 期, 最新在前):`);
      for (const t of trends) {
        const margin = t.netMargin !== null ? formatPct(t.netMargin) : 'N/A';
        const rev = t.revenue !== null ? formatMoney(t.revenue) : 'N/A';
        const ni = t.netIncome !== null ? formatMoney(t.netIncome) : 'N/A';
        const ocf = t.operatingCashFlow !== null ? formatMoney(t.operatingCashFlow) : 'N/A';
        lines.push(`    - ${t.period}: 营收=${rev} ｜ 净利=${ni} ｜ 净利率=${margin} ｜ OCF=${ocf}`);
      }
    }
  }

  const v = block.valuation;
  if (v) {
    lines.push('');
    lines.push(`估值上下文 (${v.baseCurrency}, 截至 ${v.computedAt.slice(0, 19)}Z):`);
    const cap = compact([
      v.marketCap !== null ? `市值=${formatMoney(v.marketCap)}` : null,
      v.enterpriseValue !== null ? `EV=${formatMoney(v.enterpriseValue)}` : null,
    ]);
    if (cap.length) lines.push(`  规模: ${cap.join(' ｜ ')}`);

    if (v.pe5yHigh !== null && v.pe5yLow !== null) {
      const pctStr = v.pe5yPercentile !== null ? `当前百分位=${v.pe5yPercentile.toFixed(0)}` : '当前百分位=N/A';
      const medStr = v.pe5yMedian !== null ? ` 中位=${v.pe5yMedian.toFixed(2)}` : '';
      lines.push(
        `  PE 历史: [${v.pe5yLow.toFixed(2)}, ${v.pe5yHigh.toFixed(2)}]${medStr} ｜ ${pctStr} (基于 ${v.peHistorySeries.length} 期 FY EPS)`,
      );
    }

    if (v.impliedGrowthRate !== null) {
      const a = v.impliedGrowthAssumptions;
      lines.push(
        `  反向 DCF: 隐含 10y 增速=${formatPct(v.impliedGrowthRate)} (WACC=${formatPct(a.wacc)}, g_t=${formatPct(a.terminalGrowth)})`,
      );
    }

    if (v.fairValuePerShare !== null && v.fairValueAssumedGrowth !== null) {
      const upStr = v.upside !== null ? ` (相对当前 ${v.upside >= 0 ? '+' : ''}${formatPct(v.upside)})` : '';
      lines.push(
        `  正向 DCF: 公允价=${v.fairValuePerShare.toFixed(2)} ｜ 假设增速=${formatPct(v.fairValueAssumedGrowth)}${upStr}`,
      );
    }
  }

  const t = block.technical;
  if (t) {
    lines.push('');
    lines.push(`技术指标 (${t.bars} 个交易日, 截至 ${t.asOf.slice(0, 10)}):`);
    const trend = compact([
      t.lastClose !== null ? `收盘=${t.lastClose.toFixed(2)}` : null,
      t.sma20 !== null ? `SMA20=${t.sma20.toFixed(2)}` : null,
      t.sma50 !== null ? `SMA50=${t.sma50.toFixed(2)}` : null,
      t.sma200 !== null ? `SMA200=${t.sma200.toFixed(2)}` : null,
      t.currentVsSma200 ? `vs SMA200=${t.currentVsSma200}` : null,
    ]);
    if (trend.length) lines.push(`  趋势: ${trend.join(' ｜ ')}`);

    const momentum = compact([
      t.rsi14 !== null ? `RSI14=${t.rsi14.toFixed(1)}` : null,
      t.macdLine !== null ? `MACD=${t.macdLine.toFixed(3)}` : null,
      t.macdSignal !== null ? `signal=${t.macdSignal.toFixed(3)}` : null,
      t.macdHistogram !== null ? `hist=${t.macdHistogram.toFixed(3)}` : null,
      t.macdTrend ? `MACD趋势=${t.macdTrend}` : null,
    ]);
    if (momentum.length) lines.push(`  动量: ${momentum.join(' ｜ ')}`);

    const volatility = compact([
      t.atr14 !== null ? `ATR14=${t.atr14.toFixed(2)}` : null,
      t.bollingerUpper !== null
        ? `BB上=${t.bollingerUpper.toFixed(2)} 中=${t.bollingerMiddle!.toFixed(2)} 下=${t.bollingerLower!.toFixed(2)}`
        : null,
      t.bollingerPosition ? `BB位置=${t.bollingerPosition}` : null,
    ]);
    if (volatility.length) lines.push(`  波动率: ${volatility.join(' ｜ ')}`);

    const sr = compact([
      t.nearestSupport !== null ? `最近支撑=${t.nearestSupport.toFixed(2)}` : null,
      t.nearestResistance !== null ? `最近阻力=${t.nearestResistance.toFixed(2)}` : null,
    ]);
    if (sr.length) lines.push(`  支撑/阻力: ${sr.join(' ｜ ')}`);

    const volume = compact([
      t.volumeVs20dAvg !== null ? `成交/20日均=${t.volumeVs20dAvg.toFixed(2)}x` : null,
      t.obvTrend ? `OBV趋势=${t.obvTrend}` : null,
    ]);
    if (volume.length) lines.push(`  成交量: ${volume.join(' ｜ ')}`);

    lines.push(`  综合: 趋势=${t.trend} ｜ 动量状态=${t.momentum}`);
  }

  const pc = block.peerComparison;
  if (pc && pc.peers.length > 0) {
    lines.push('');
    lines.push(`同行对比 (sector=${pc.sector}, ${pc.peers.length} 只对比):`);
    const renderMetric = (label: string, m: typeof pc.subjectVsPeerMedian.pe, fmt: (n: number) => string) => {
      if (m.peerCount === 0) return null;
      const sub = m.subject !== null ? fmt(m.subject) : 'N/A';
      const med = m.median !== null ? fmt(m.median) : 'N/A';
      const rank = m.rankPercentile !== null ? `${m.rankPercentile.toFixed(0)}百分位` : 'N/A';
      return `  ${label}: 主体=${sub} ｜ 行业中位=${med} ｜ 排名=${rank}`;
    };
    const peLine = renderMetric('PE', pc.subjectVsPeerMedian.pe, (n) => n.toFixed(2));
    const pbLine = renderMetric('PB', pc.subjectVsPeerMedian.pb, (n) => n.toFixed(2));
    const roeLine = renderMetric('ROE', pc.subjectVsPeerMedian.roe, formatPct);
    const marginLine = renderMetric('净利率', pc.subjectVsPeerMedian.netMargin, formatPct);
    const growthLine = renderMetric('营收YoY', pc.subjectVsPeerMedian.revenueGrowthYoY, formatPct);
    for (const l of [peLine, pbLine, roeLine, marginLine, growthLine]) {
      if (l) lines.push(l);
    }
    lines.push(`  参与对比: ${pc.peers.map((p) => p.symbol).join(', ')}`);
  }

  if (block.historicalContext.length > 0) {
    lines.push('');
    lines.push('历史百分位:');
    const labelMap: Record<string, string> = {
      pe: 'PE',
      pb: 'PB',
      ps: 'PS',
      fcfYield: 'FCFYield',
    };
    for (const ctx of block.historicalContext) {
      const cur = ctx.current !== null ? ctx.current.toFixed(2) : 'N/A';
      const pct = ctx.percentile5y !== null ? `${ctx.percentile5y.toFixed(0)}百分位` : 'N/A';
      const zs = ctx.zScore5y !== null ? `z=${ctx.zScore5y.toFixed(2)}` : 'z=N/A';
      lines.push(
        `  ${labelMap[ctx.metric] ?? ctx.metric}: 当前=${cur} ｜ 在 ${ctx.history.length} 期范围中=${pct} (${zs})`,
      );
    }
  }

  if (block.redFlags.length > 0) {
    lines.push('');
    lines.push(`红旗 (${block.redFlags.length} 条, 由规则引擎检出):`);
    for (const f of block.redFlags) {
      lines.push(`  - [${f.severity.toUpperCase()}/${f.category}] ${f.title}`);
      lines.push(`      ${f.description}`);
    }
  }

  if (block.warnings.length > 0) {
    lines.push('');
    lines.push(`计算告警 (${block.warnings.length} 条, 数据缺失或边界):`);
    for (const w of block.warnings) {
      lines.push(`  - [${w.code}] ${w.metric}: ${w.detail}`);
    }
  }

  return lines;
}

function compact(arr: (string | null)[]): string[] {
  return arr.filter((x): x is string => x !== null);
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

/**
 * RFC financials Phase 1：渲染 FinancialsBundle 为多行人类可读块。
 * - 每个 period 一行，格式：`<period>: revenue=X, netIncome=X, OCF=X, FCF=X, EPS=X`
 * - 数字按"亿"/"M"/"B"自动缩放以便阅读
 * - 顶部带 provenance（tier=A, source=sec.gov）
 */
function formatFinancialsBlock(fact: {
  value: unknown;
  asOf: string;
  retrievedAt: string;
  sourceTier: string;
  sourceUrl: string;
  currency?: string;
}): string[] {
  // FinancialsBundle.periods 形态从 research-core/ports/financials.ts 来。
  // 这里 cast 为运行时 shape（与 schema 一致）。
  const bundle = fact.value as {
    periods?: Array<{
      fiscalPeriod: string;
      kind: 'FY' | 'Q' | 'TTM';
      income?: Record<string, { value: number; unit: string } | undefined>;
      cashFlow?: Record<string, { value: number; unit: string } | undefined>;
    }>;
    currency?: string;
  };
  const periods = bundle.periods ?? [];
  const currency = bundle.currency ?? fact.currency ?? '';
  const provenance = [
    `asOf=${fact.asOf.slice(0, 10)}`,
    `retrievedAt=${fact.retrievedAt.slice(0, 16)}Z`,
    `tier=${fact.sourceTier}`,
    `source=${shortHost(fact.sourceUrl)}`,
  ].join(' ');
  const out: string[] = [];
  out.push(`- financials: 三表 (${currency}, ${periods.length} periods)  [${provenance}]`);
  for (const p of periods.slice(0, 6)) {
    const parts: string[] = [];
    const rev = p.income?.revenue?.value;
    const ni = p.income?.netIncome?.value;
    const eps = p.income?.eps;
    const ocf = p.cashFlow?.operatingCashFlow?.value;
    const fcf = p.cashFlow?.freeCashFlow?.value;
    if (rev !== undefined) parts.push(`revenue=${formatLargeNum(rev)}`);
    if (ni !== undefined) parts.push(`netIncome=${formatLargeNum(ni)}`);
    if (ocf !== undefined) parts.push(`OCF=${formatLargeNum(ocf)}`);
    if (fcf !== undefined) parts.push(`FCF=${formatLargeNum(fcf)}`);
    if (eps?.value !== undefined) parts.push(`EPS=${eps.value}${eps.unit ? ' ' + eps.unit : ''}`);
    out.push(`    ${p.fiscalPeriod}: ${parts.join('  ')}`);
  }
  return out;
}

/** 把 1234567890 → '1.23B'，14500000 → '14.5M'。便于 prompt 内可读。 */
function formatLargeNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

function formatFactValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  const json = JSON.stringify(value);
  if (json.length > 500) {
    return json.slice(0, 497) + '...';
  }
  return json;
}

/**
 * v0.6 PRD §10.2 — render `EvidencePackV2.systemContext` as a Chinese-language
 * prompt block. Section prompt builders consume this output unchanged; they
 * MUST NOT re-derive blockedClaims from plan/snapshot directly (single-source
 * invariant).
 */
function formatSystemContextBlock(ctx: NonNullable<EvidencePackV2['systemContext']>): string {
  const lines: string[] = [];
  lines.push('【研究计划约束 (systemContext)】');
  if (ctx.planId) {
    lines.push(`- plan: ${ctx.planId}${ctx.snapshotId ? ` / snapshot: ${ctx.snapshotId}` : ''}`);
  } else if (ctx.snapshotId) {
    lines.push(`- snapshot: ${ctx.snapshotId}`);
  }
  lines.push(`- 置信度上限 (confidenceCap): ${ctx.confidenceCap}`);
  lines.push(`- 最低可行事实 (minimumViable): ${ctx.minimumViable ? '满足' : '⚠ 未满足 — 结论必须保守'}`);
  if (ctx.planDisclaimer.length > 0) {
    lines.push('- planDisclaimer:');
    for (const d of ctx.planDisclaimer) lines.push(`  - ${d}`);
  }
  if (ctx.blockedClaims.length > 0) {
    lines.push(
      `- ⛔ blockedClaims（以下断言一律禁止输出）: ${ctx.blockedClaims.join(', ')}`,
    );
  }
  if (ctx.skippedSlots.length > 0) {
    const critical = ctx.skippedSlots.filter((s) => s.priority === 'critical');
    const optional = ctx.skippedSlots.filter((s) => s.priority !== 'critical');
    if (critical.length > 0) {
      lines.push(
        `- 关键 skipped slots: ${critical
          .map((s) => `${s.slot}(${s.reason})${s.subjectInstrumentId ? `[${s.subjectInstrumentId}]` : ''}`)
          .join(', ')}`,
      );
    }
    if (optional.length > 0) {
      lines.push(
        `- 可选 skipped slots: ${optional
          .map((s) => `${s.slot}(${s.reason})`)
          .join(', ')}`,
      );
    }
  }
  if (ctx.degradedReasons.length > 0) {
    lines.push(`- degradedReasons: ${ctx.degradedReasons.join('；')}`);
  }
  lines.push('上述约束由 plan compiler 注入；分析必须遵守 confidenceCap 与 blockedClaims；section prompt 不得自行扩展。');
  return lines.join('\n');
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Build the structured-JSON extraction prompts that go to provider.complete().
 * Mirrors apps/api/src/ai/prompts/prompt.registry.ts:STRUCTURED_JSON_SYSTEM
 * with one addition: requires `schemaVersion: 'agent-result-v1'` to satisfy
 * our zod StructuredJson contract.
 */
export function buildStructuredOutputPrompts(
  sectionType: string,
  reportMarkdown: string,
  citationUrls: string[],
): { system: string; user: string } {
  const system = `你是一个数据提取专家。根据提供的分析报告，提取关键数据并输出严格的 JSON 格式。

【硬性要求】
- 只输出 JSON 对象本身，不要任何前后缀文字、不要 markdown 代码块标记、不要解释
- 必须以 { 开头、以 } 结尾
- 所有字符串使用双引号
- 数字字段无数据时使用 null（不要使用 "N/A" 或 "" 字符串）

【完整 JSON 结构（所有字段都必填）】
{
  "schemaVersion": "agent-result-v1",
  "conclusion": {
    "signal": "BULLISH" | "NEUTRAL" | "BEARISH",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "oneLiner": "一句话总结，10-50 个汉字",
    "evidence": []
  },
  "evidence": [
    {
      "claim": "对报告中某个论断的简述",
      "citations": [
        {
          "title": "来源标题",
          "url": "来源 URL（必须使用下方提供的 allowed URL 列表中的值）",
          "sourceType": "NEWS" | "FILING" | "RESEARCH" | "DATA_PROVIDER" | "SOCIAL" | "OTHER",
          "retrievedAt": "ISO 8601 时间戳，如 2025-01-15T10:30:00Z",
          "qualityTier": "A" | "B" | "C" | "D" | "E"
        }
      ]
    }
  ],
  "dataAvailability": {
    "missingFields": ["报告中缺失或不确定的关键数据点列表，无则填 []"],
    "reason": "数据缺失原因或数据完整性说明"
  },
  "dataAsOf": "YYYY-MM-DD",
  "disclaimer": "标准免责声明文本"
}

【evidence 数组要求】
- 至少包含 1 项 claim
- 若 allowed URL 列表为空，使用 citations: [] 空数组
- 每个 claim 应基于报告中的关键论断

【citation.qualityTier 强制分级（MVP doc §4.3.4）】
每条 citation 必须填 qualityTier，按以下定义判断：
- "A": 公司年报 / 季报 / 招股书 / SEC EDGAR / HKEX / 监管披露 / 公司公告原文
- "B": 行业研究报告 / 大行卖方研究 / 评级机构报告 / 公司业绩会 transcript
- "C": 主流财经媒体（路透 / 彭博 / 财新 / WSJ / FT / 华尔街见闻 / 证券时报）
- "D": 博客 / 独立分析师评论 / Seeking Alpha / 知乎专业回答 / 行业论坛专业帖
- "E": 社交媒体 / 散户论坛 / 维基百科 / 未署名来源（这种 claim 必须再用 A/B 级核验）

⚠️ 缺失 qualityTier 将被视为 E 级处理。

【conclusion 决策规则】
- signal: 综合报告整体倾向
- confidence: 数据完整性 + 论证强度的综合判断
- oneLiner: 简明扼要总结投资观点`;

  const user = `以下是一份关于某只股票的 ${sectionType} 分析报告：

---
${reportMarkdown}
---

已知引用 URL 列表（provider 返回的合法来源）：
${citationUrls.map((u) => `- ${u}`).join('\n')}

请根据上述报告内容，提取关键数据并输出符合 ${sectionType} 类型的 structuredJson。只输出纯 JSON，不要包含任何代码块标记或其他文字。`;

  return { system, user };
}
