/** Deterministic stock-scope parsing. This is deliberately conservative:
 * financial abbreviations and market words are never enough to change scope. */
const DENYLIST = new Set([
  'TTM', 'LTM', 'NTM', 'FWD', 'YOY', 'QOQ', 'YTD', 'PE', 'PB', 'PEG',
  'ROE', 'ROA', 'FCF', 'DCF', 'CAGR', 'MA', 'RSI', 'MACD', 'HK', 'SS',
  'US', 'CN', 'SZ', 'SH',
]);

const SWITCH_RE = /(?:改看|换成|切换到|转到|分析|研究一下|看一下|关注|switch\s+to|change\s+to|look\s+at|analy[sz]e)/i;
const COMPARE_RE = /(?:比较|对比|相比|对照|和.+(?:比|相比)|\bvs\.?\b|\bcompare\b)/i;
const INDICATOR_RE = /(?:均线|指标|金叉|死叉|技术面|超买|超卖)/i;

export interface StockScopeDecision {
  action: 'MAINTAIN' | 'SWITCH' | 'COMPARE' | 'AMBIGUOUS';
  primaryStockId: string;
  mentionedStockIds: string[];
  allowedStockIds: string[];
  mentionedSymbols: string[];
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export function parseStockScope(
  question: string,
  current: { stockId: string; symbol: string },
): StockScopeDecision {
  const text = question ?? '';
  const candidates = new Set<string>();
  // A bare uppercase word is not evidence of a ticker.  It is common for
  // questions to contain CEO/EPS/I/etc.; only exchange-qualified or numeric
  // symbols are unambiguous without an explicit scope verb.
  const explicit = /\b(?:[A-Z]{1,6}\.[A-Z]{2}|\d{4,6}\.(?:HK|SS|SZ|SH))\b/g;
  for (const match of text.match(explicit) ?? []) {
    const symbol = normalizeSymbol(match);
    if (!DENYLIST.has(symbol)) candidates.add(symbol);
  }
  // Bare lowercase tickers are accepted only next to a strong scope verb.
  if (SWITCH_RE.test(text) || COMPARE_RE.test(text)) {
    const lowerTicker = /(?:改看|换成|切换到|转到|分析|研究|看一下|switch\s+to|change\s+to|look\s+at|analy[sz]e|compare(?:\s+with)?|\bvs\.?)\s*([a-z]{1,6})\b/gi;
    for (const match of text.matchAll(lowerTicker)) {
      const symbol = normalizeSymbol(match[1]);
      if (!DENYLIST.has(symbol)) candidates.add(symbol);
    }
  }
  // For comparisons written with the verb at the end ("AAPL 和 MSFT 对比"),
  // extract only the two syntactic operands. Never scan every uppercase word
  // merely because some unrelated word such as "分析" appears elsewhere.
  if (COMPARE_RE.test(text) && !INDICATOR_RE.test(text)) {
    const comparison = /\b([A-Z]{1,6})\b\s*(?:和|与|vs\.?|versus)\s*\b([A-Z]{1,6})\b/gi;
    for (const match of text.matchAll(comparison)) {
      for (const raw of [match[1], match[2]]) {
        const symbol = normalizeSymbol(raw);
        if (!DENYLIST.has(symbol)) candidates.add(symbol);
      }
    }
  }

  const currentSymbol = normalizeSymbol(current.symbol);
  const symbols = [...candidates].filter((value) => value !== currentSymbol);
  const hasCompare = COMPARE_RE.test(text);
  const hasSwitch = SWITCH_RE.test(text);
  const action =
    hasCompare && symbols.length > 0
      ? 'COMPARE'
      : hasSwitch && symbols.length === 1
        ? 'SWITCH'
        : symbols.length > 0
          ? 'AMBIGUOUS'
          : 'MAINTAIN';

  return {
    action,
    primaryStockId: current.stockId,
    mentionedStockIds: [],
    allowedStockIds: [current.stockId],
    mentionedSymbols: symbols,
  };
}

export function isUnsupportedQuestion(question: string): boolean {
  const value = question ?? '';
  const chineseAction = /(?:买入|卖出|建仓|清仓)/.test(value)
    && /(?:替我|帮我|我应该|该不该|建议我|给我|执行|下单|多少|\d+\s*%)/.test(value);
  const chinesePosition = /(?:配置|设为|给出|建议).*(?:仓位|持仓比例)|(?:仓位|持仓比例).*(?:多少|\d+\s*%)/.test(value);
  const englishAction = /\b(?:all[- ]?in|take a position|should i (?:buy|sell)|buy|sell)\b/i.test(value)
    && /\b(?:i|me|my|should|position|\d+\s*%|all[- ]?in)\b/i.test(value);
  return chineseAction || chinesePosition || englishAction;
}

export function requiresFreshAnalysis(question: string): boolean {
  return /(?:最新|今天|刚刚|当前价格|现在价格|财报发布后|最新财报|刚发布|today|latest|current price|after earnings)/i.test(
    question ?? '',
  );
}
