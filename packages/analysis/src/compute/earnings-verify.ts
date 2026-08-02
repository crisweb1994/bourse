export interface EarningsDerivationText {
  id: string;
  filingId: string;
  contentHash: string;
  text: string;
  pages?: Array<{
    page: number;
    startOffset: number;
    endOffset: number;
  }>;
}

interface LocatedSpan {
  quote: string;
  startOffset: number;
  endOffset: number;
  page?: number;
}

export function locateSourceSpan(
  text: string,
  quote: string,
  pageHint?: number,
  pages?: EarningsDerivationText['pages'],
): LocatedSpan | null {
  const normalizedText = normalizeWithOffsetMap(text);
  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote) return null;

  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= normalizedText.value.length - normalizedQuote.length) {
    const index = normalizedText.value.indexOf(normalizedQuote, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + 1;
  }

  const candidates: Array<{ startOffset: number; endOffset: number; page?: number }> = [];
  for (const start of matches) {
    const endIndex = start + normalizedQuote.length - 1;
    const startOffset = normalizedText.offsets[start];
    const lastOffset = normalizedText.offsets[endIndex];
    if (startOffset === undefined || lastOffset === undefined) continue;
    const page = pages?.find(
      (entry) => startOffset >= entry.startOffset && startOffset < entry.endOffset,
    )?.page;
    if (pageHint !== undefined && page !== pageHint) continue;
    candidates.push({
      startOffset,
      endOffset: lastOffset + 1,
      ...(page ? { page } : {}),
    });
  }

  if (candidates.length !== 1) return null;
  const match = candidates[0];
  return {
    quote: text.slice(match.startOffset, match.endOffset),
    startOffset: match.startOffset,
    endOffset: match.endOffset,
    ...(match.page ? { page: match.page } : {}),
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeWithOffsetMap(value: string): { value: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (/\s/.test(char)) {
      if (normalized.length > 0 && !inWhitespace) {
        normalized += ' ';
        offsets.push(i);
      }
      inWhitespace = true;
      continue;
    }
    normalized += char.toLowerCase();
    offsets.push(i);
    inWhitespace = false;
  }
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    offsets.pop();
  }
  return { value: normalized, offsets };
}
