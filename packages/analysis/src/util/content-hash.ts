import { createHash } from 'crypto';

/**
 * B3: canonical content hash for cross-provider dedup.
 * Algorithm: sha256(normalize(markdown || text || canonicalUrl))
 */
export function computeContentHash(input: {
  markdown?: string;
  text?: string;
  canonicalUrl?: string;
}): string {
  const raw = input.markdown ?? input.text ?? input.canonicalUrl ?? '';
  if (!raw) {
    throw new Error('computeContentHash: at least one of markdown/text/canonicalUrl is required');
  }
  const normalized = normalize(raw);
  return createHash('sha256').update(normalized).digest('hex');
}

function normalize(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
