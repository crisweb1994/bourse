const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
];

/**
 * Best-effort canonical URL: lowercase host, strip tracking params, drop fragments.
 */
export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input);
    u.host = u.host.toLowerCase();
    u.hash = '';
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return input;
  }
}
