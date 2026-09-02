import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization: recursively sorts object keys so the output
 * is key-order independent, then a sha256 hex digest over it.
 *
 * KISS T2-1: this was previously hand-copied in three places (chat
 * generation.service, earnings structured-selection.service, analysis
 * workflow-adapter). The hashes back DB upsert keys — one implementation,
 * one semantic. Note this is deliberately NOT market-data's
 * `computeContentHash`, which normalizes whitespace and lowercases; the two
 * are not interchangeable.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable key-order-independent sha256 hash (hex) of the canonical JSON. */
export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
