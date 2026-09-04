import { HttpError } from '../http';
import type { FetchLike } from '../types';

/**
 * Shared HTTP/query rituals for the four Eastmoney financials connectors
 * (CN v1/v2 + HK v1/v2 — KISS C6 remainder). The four files previously
 * carried near-verbatim copies of fetchRows / readBody / the datacenter
 * query builder; the copies had already drifted in formatting and one
 * readBody had missed the HttpError 429 classification.
 *
 * Headers stay per-file: the CN and HK endpoints are separate Eastmoney
 * properties with different Referer/UA conventions.
 */

export async function readEastmoneyBody(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<string> {
  const res = await fetchLike(url, { headers, signal });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  return res.text ? await res.text() : JSON.stringify(await res.json());
}

export async function fetchEastmoneyRows<TRow>(
  fetchLike: FetchLike,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<TRow[]> {
  const res = await fetchLike(url, { headers, signal });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  const body = res.text ? await res.text() : JSON.stringify(await res.json());
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON parse failed');
  }
  // Some failures come back HTTP 200 + success:false (e.g. unknown reportName).
  const root = parsed as {
    success?: boolean;
    message?: string;
    result?: { data?: unknown };
  };
  if (root.success === false) {
    throw new Error(root.message ?? 'eastmoney success=false');
  }
  const rows = root.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows as TRow[];
}

/** datacenter query: filter by SECURITY_CODE (CN) or SECUCODE (HK). */
export function eastmoneyQuery(
  baseUrl: string,
  filterField: 'SECURITY_CODE' | 'SECUCODE',
  filterValue: string,
  pageSize: number,
  reportName: string,
): string {
  return (
    `${baseUrl}?reportName=${reportName}` +
    `&columns=ALL` +
    `&filter=(${filterField}%3D%22${encodeURIComponent(filterValue)}%22)` +
    `&pageNumber=1&pageSize=${pageSize}` +
    `&sortColumns=REPORT_DATE&sortTypes=-1`
  );
}
