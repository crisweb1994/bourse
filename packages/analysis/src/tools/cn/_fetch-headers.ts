/**
 * Hotfix (2026-05-15) — Node undici's default User-Agent is literally
 * `node`, which CN data sources (tencent / cninfo / eastmoney / akshare)
 * treat as a bot and 429 immediately. Every CN tool's fetch must spread
 * `cnBrowserHeaders` into `init.headers` to look like a normal browser.
 *
 * UA string mirrors a recent Chrome on macOS — kept as a constant rather
 * than rotated, because:
 *   - upstream WAF rules we've seen care more about "is `node` UA?" than
 *     about UA-version drift
 *   - rotating UAs has cache-hit + reproducibility tradeoffs
 *
 * `Accept-Language: zh-CN` blunts another common WAF signal (English UA
 * hitting a CN-only endpoint). `Accept` left broad so different endpoints
 * (HTML / JSON / JSONP) all parse.
 */
export const CN_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const cnBrowserHeaders: Record<string, string> = {
  'User-Agent': CN_BROWSER_USER_AGENT,
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
};

/**
 * Shared fetch shape for CN tools: a text-only response surface. Tool bodies
 * accept an optional `fetchImpl` of this type so tests can feed fixture bodies;
 * production uses the default `fetch` wrapper. Each CN tool internally bridges
 * this to research-core's `FetchLike` (json + text) when delegating to a
 * connector.
 */
export type CnToolFetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
