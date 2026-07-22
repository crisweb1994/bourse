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

export function computeBinaryContentHash(input: Uint8Array | string): string {
  if ((typeof input === 'string' && input.length === 0) || (input instanceof Uint8Array && input.byteLength === 0)) {
    throw new Error('computeBinaryContentHash: input cannot be empty');
  }
  return createHash('sha256').update(input).digest('hex');
}

function normalize(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
