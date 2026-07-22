/** Shared by all connector subtrees (instrument / finance / filings / …). */
export type FetchLike = (
  input: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Default GET. Cninfo (filings) uses POST form-encoded bodies. */
    method?: string;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Some upstreams (tencent qt.gtimg.cn) return text/javascript; optional so
   *  json-only stubs in tests keep working. Connectors that need text must
   *  fall back gracefully when `text` is undefined. */
  text?(): Promise<string>;
  /** Binary response body for PDFs and other filing artifacts. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export interface ConnectorRunContext {
  fetchLike?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * plan-v2 Wave 1.8 — opt out of provider-specific unstable supplementary
   * fetches. Yahoo connector reads this to skip the v10 quoteSummary call
   * (which requires crumb auth) and rely on v8/chart alone for quote data.
   * Caller accepts that marketCap + peRatio will be undefined in this mode.
   */
  disableSummaryDetail?: boolean;
}
