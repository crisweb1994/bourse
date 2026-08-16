const FRIENDLY_HEADINGS: Record<string, string> = {
  methods: '估值方法',
  inputs: '估值依据',
  findings: '关键发现',
  scenarios: '情景分析',
  limitations: '限制与缺口',
  conclusion: '结论',
  confidence: '置信度',
};

const INTERNAL_SECTION = new Set(['assessment', 'schemaVersion', 'type']);

/**
 * Report markdown is generated for machines and people at the same time.
 * Keep the narrative, but remove the schema vocabulary before it reaches the
 * reader-facing report. Structured values remain available to the chart and
 * fallback cards through `structuredJson`.
 */
export function cleanAnalysisMarkdown(content: string, sectionType?: string): string {
  if (!content.trim()) return content;

  const output: string[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let headingToSkip: { level: number } | null = null;
  let currentHeading = '';

  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const rawTitle = stripMarkdown(heading[2]).trim();
      const titleKey = rawTitle.toLowerCase();

      if (headingToSkip && level <= headingToSkip.level) headingToSkip = null;
      if (INTERNAL_SECTION.has(rawTitle) || INTERNAL_SECTION.has(titleKey)) {
        headingToSkip = { level };
        currentHeading = titleKey;
        continue;
      }

      currentHeading = titleKey;
      const friendlyHeading = FRIENDLY_HEADINGS[titleKey];
      output.push(friendlyHeading ? `${heading[1]} ${friendlyHeading}` : line);
      continue;
    }

    if (headingToSkip) continue;
    if (isInternalMetadataLine(line)) continue;

    const readableLine = sectionType === 'VALUATION_SCENARIOS' && currentHeading === 'inputs'
      ? formatValuationInputLine(line)
      : line;
    output.push(humanizeAnalysisText(readableLine));
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Convert stable enum/metric keys that can leak into generated prose. */
export function humanizeAnalysisText(value: string): string {
  let result = value;
  const percentMetrics = ['ROE', '净利率', 'revenueGrowthYoY', 'earningsGrowthYoY', 'revenueCagr3y', 'fcfCagr3y', '营收同比增速', '盈利同比增速', '过去 3 年营收 CAGR', '过去 3 年 FCF CAGR'];
  for (const metric of percentMetrics) {
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(${escaped}\\s*(?:为|:|：)\\s*)(-?\\d+(?:\\.\\d+)?)`, 'g'), (_, prefix: string, number: string) => `${prefix}${formatPercent(Number(number))}`);
  }
  for (const metric of ['P/E', 'P/B', 'P/S', 'cashConversionRatio', 'accrualRatio', 'debtToEquity']) {
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(${escaped}\\s*(?:为|:|：)\\s*)(-?\\d+(?:\\.\\d+)?)`, 'g'), (_, prefix: string, number: string) => `${prefix}${formatNumber(Number(number))}${/^P\//.test(metric) ? ' 倍' : ''}`);
  }
  result = result.replace(/(EPS\s*(?:为|:|：)\s*)(-?\d+(?:\.\d+)?)/g, (_, prefix: string, number: string) => `${prefix}${formatNumber(Number(number))}`);
  result = result.replace(/(20\d{2}\s*年\s*)(-?\d+(?:\.\d+)?)(?=[、，,）\s])/g, (_, year: string, number: string) => `${year}${formatNumber(Number(number))}`);
  result = result.replace(/((?:营收同比|盈利同比)\s*)(-?\d+(?:\.\d+)?)/g, (_, prefix: string, number: string) => `${prefix}${formatPercent(Number(number))}`);
  result = result.replace(/(持股比例\s*(?:为|:|：)\s*)\*{0,2}(-?\d+(?:\.\d+)?)\*{0,2}/g, (_, prefix: string, number: string) => `${prefix}${formatPercent(Number(number))}`);
  for (const metric of ['lastClose', 'sma20', 'sma50', 'sma200', 'RSI14']) {
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(${escaped}\\s+)(-?\\d+(?:\\.\\d+)?)`, 'g'), (_, prefix: string, number: string) => `${prefix}${formatNumber(Number(number))}`);
  }

  const labels: Record<string, string> = {
    cashConversionRatio: '现金转换率',
    accrualRatio: '应计率',
    debtToEquity: '债务权益比',
    revenueGrowthYoY: '营收同比增速',
    earningsGrowthYoY: '盈利同比增速',
    revenueCagr3y: '3 年营收 CAGR',
    fcfCagr3y: '3 年 FCF CAGR',
    lastClose: '收盘价',
    sma20: '20 日均线',
    sma50: '50 日均线',
    sma200: '200 日均线',
    trend: '趋势',
    momentum: '动量',
    confidence: '置信度',
  };
  for (const [source, label] of Object.entries(labels)) {
    result = result.replace(new RegExp(`\\b${source}\\b`, 'g'), label);
  }

  const enums: Record<string, string> = {
    STRONG: '较强',
    LEADING: '领先',
    COMPETITIVE: '有竞争力',
    MIXED: '一般',
    WEAK: '较弱',
    CHALLENGED: '承压',
    UNDERVALUED: '低估',
    FAIR: '合理',
    OVERVALUED: '高估',
    UNASSESSABLE: '无法评估',
    POSITIVE: '偏积极',
    NEUTRAL: '中性',
    NEGATIVE: '偏谨慎',
    HIGH: '高',
    MEDIUM: '中',
    LOW: '低',
    bearish: '偏空',
    bullish: '偏多',
    sideways: '横盘',
    neutral: '中性',
  };
  for (const [source, label] of Object.entries(enums)) {
    result = result.replace(new RegExp(`\\b${source}\\b`, 'g'), label);
  }
  return result;
}

function stripMarkdown(value: string): string {
  return value.replace(/[*_`]/g, '');
}

function isInternalMetadataLine(line: string): boolean {
  const normalized = line.replace(/^\s*[-*]\s*/, '').trim();
  return (
    /^\*{0,2}(?:assessment|schemaVersion|type|basedOnIncompleteSections)\s*[:：]/i.test(normalized) ||
    /^(?:assessment|schemaVersion|type|basedOnIncompleteSections)\s*[:：]/i.test(normalized)
  );
}

function formatValuationInputLine(line: string): string {
  const match = line.match(/^(\s*[-*]\s+)\*\*(.+?)\*\*(.*)$/);
  if (!match) return line;

  const separator = match[2].indexOf('：');
  if (separator < 0) return line;

  const rawLabel = match[2].slice(0, separator).trim();
  const rawValue = match[2].slice(separator + 1).trim();
  const label = rawLabel === '股价' ? '当前股价' : rawLabel;
  const value = formatValuationValue(rawLabel, rawValue);
  return `${match[1]}**${label}：${value}**${match[3]}`;
}

function formatValuationValue(label: string, value: string): string {
  if (label === '技术状态') return formatTechnicalState(value);
  if (label === '一致预期 EPS') {
    return value.replace(/(\d{4}\s*年?\s*)(-?\d+(?:\.\d+)?)/g, (_, year: string, number: string) => `${year}${formatNumber(Number(number))}`);
  }
  if (label === '北向持股') {
    return value.replace(/(占流通股\s*)(-?\d+(?:\.\d+)?)/, (_, prefix: string, number: string) => `${prefix}${formatPercent(Number(number))}`)
      .replace(/(-?\d+(?:\.\d+)?)(?=\s*万股)/, (number) => formatNumber(Number(number)));
  }
  if (/ROE|净利率|增速|CAGR/.test(label)) return value;

  const number = value.match(/-?\d+(?:\.\d+)?/);
  if (!number) return value;
  const parsed = Number(number[0]);
  let formatted = formatNumber(parsed);
  return value.replace(number[0], formatted);
}

function formatTechnicalState(value: string): string {
  const labels: Record<string, string> = {
    lastClose: '收盘价',
    sma20: '20 日均线',
    sma50: '50 日均线',
    sma200: '200 日均线',
    RSI14: 'RSI14',
    MACD: 'MACD',
    trend: '趋势',
    momentum: '动量',
  };
  const states: Record<string, string> = {
    bearish: '偏空',
    bullish: '偏多',
    sideways: '横盘',
    neutral: '中性',
  };

  return value
    .split('、')
    .map((part) => {
      const match = part.match(/^(lastClose|sma20|sma50|sma200|RSI14|MACD|trend|momentum)\s+(.+)$/);
      if (!match) return part;
      const key = match[1];
      const raw = match[2];
      const display = states[raw] ?? (Number.isFinite(Number(raw)) ? formatNumber(Number(raw)) : raw);
      return `${labels[key]} ${display}`;
    })
    .join('、');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100)}%`;
}
