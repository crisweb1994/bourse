import {
  ChatSsePayloadSchema,
  Market,
  DigestSession,
  ChannelType,
} from '@bourse/shared-types';
import type {
  ActiveAnalysisType,
  AnalysisStatus,
  AnalysisType,
  Confidence,
  SectionType,
  Signal,
  ChatSsePayload,
  StockSearchResult,
  WatchlistItemDto,
} from '@bourse/shared-types';
import { API_URL, csrfHeaders } from './utils';

async function fetchApi<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message || res.statusText);
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Stock APIs
export async function searchStocks(query: string): Promise<StockSearchResult[]> {
  if (!query || query.length < 1) return [];
  return fetchApi(`/api/stocks/search?q=${encodeURIComponent(query)}`);
}

// Chat Phase 1 APIs
export interface ChatThreadDto {
  id: string;
  userId: string;
  primaryStockId: string;
  title: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  primaryStock: StockDtoBrief;
  messages?: ChatMessageDto[];
  generations?: ChatGenerationDto[];
  eligibleAnalyses?: AnalysisChatSummaryDto[];
}

export interface ChatMessageDto {
  id: string;
  generationId: string | null;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM_NOTICE';
  kind: string;
  status: string;
  content: string;
  sequence: number;
  citationRefs?: string[] | null;
  createdAt: string;
}

export interface ChatGenerationDto {
  id: string;
  threadId: string;
  clientRequestId: string;
  intent: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  contextSnapshot?: any;
  createdAt: string;
  completedAt?: string | null;
  groundedSources?: any[] | null;
  openResearchSnapshot?: {
    id: string;
    dataAsOf: string;
    gatewayVersion: string;
    sources: any[];
  } | null;
}

export interface AnalysisChatSummaryDto {
  id: string;
  stockId: string;
  symbol: string;
  analysisType: string;
  status: string;
  generatedAt: string | null;
  dataAsOf: string | null;
  overallSignal: string | null;
  overallConfidence: string | null;
  degraded: boolean;
  hasEvidenceSnapshot: boolean;
}

export type { ChatSsePayload } from '@bourse/shared-types';

export async function createChatThread(
  symbol: string,
  market?: string,
  title?: string,
): Promise<ChatThreadDto> {
  const qs = market ? `?market=${encodeURIComponent(market)}` : '';
  return fetchApi(`/api/chat/stocks/${encodeURIComponent(symbol)}/threads${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(title ? { title } : {}),
  });
}

export async function listChatThreads(
  symbol: string,
  includeArchived = false,
): Promise<ChatThreadDto[]> {
  return fetchApi(
    `/api/chat/stocks/${encodeURIComponent(symbol)}/threads?archived=${includeArchived}`,
  );
}

export async function listRecentChatThreads(
  includeArchived = false,
): Promise<ChatThreadDto[]> {
  return fetchApi(`/api/chat/threads?archived=${includeArchived}`);
}

export async function getChatThread(threadId: string): Promise<ChatThreadDto> {
  return fetchApi(`/api/chat/threads/${encodeURIComponent(threadId)}`);
}

export async function updateChatThread(
  threadId: string,
  patch: { title?: string; action?: 'archive' | 'restore' },
): Promise<ChatThreadDto> {
  return fetchApi(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(patch),
  });
}

export async function deleteChatThread(threadId: string): Promise<{ ok: boolean }> {
  return fetchApi(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  });
}

export async function createChatGeneration(
  threadId: string,
  request: {
    question: string;
    clientRequestId: string;
    analysisIds?: string[];
    sectionTypes?: string[];
    modeHint?: 'OPEN_RESEARCH' | 'ANALYSIS_GROUNDED';
  },
): Promise<ChatGenerationDto> {
  return fetchApi(`/api/chat/threads/${encodeURIComponent(threadId)}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(request),
  });
}

export async function cancelChatGeneration(generationId: string) {
  return fetchApi(`/api/chat/generations/${encodeURIComponent(generationId)}/cancel`, {
    method: 'POST',
    headers: csrfHeaders(),
  });
}

export async function streamChatGeneration(
  generationId: string,
  onEvent: (event: ChatSsePayload) => void,
  options: { afterSeq?: number; signal?: AbortSignal } = {},
): Promise<{ lastSeq: number; done: boolean }> {
  const afterSeq = options.afterSeq ?? 0;
  const response = await fetch(
    `${API_URL}/api/chat/generations/${encodeURIComponent(generationId)}/stream?afterSeq=${afterSeq}`,
    { credentials: 'include', signal: options.signal, headers: { Accept: 'text/event-stream' } },
  );
  if (!response.ok || !response.body) throw new ApiError(response.status, 'Chat 连接失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSeq = afterSeq;
  let receivedDone = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.replace(/\r\n/g, '\n').split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      const data = dataLines.join('\n');
      if (!data) continue;
      try {
        const parsed = ChatSsePayloadSchema.safeParse({
          event: eventName,
          ...JSON.parse(data),
        });
        if (!parsed.success) continue;
        const event = parsed.data;
        if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
        if (eventName === 'done') receivedDone = true;
        onEvent(event);
      } catch {
        // Ignore a malformed heartbeat; the next durable reconnect can replay.
      }
    }
  }
  return { lastSeq, done: receivedDone };
}

// Merged stock detail. Unknown symbols return candidates; known symbols return
// the stock row plus quote/profile snapshots.
export interface StockDtoBrief {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  exchange: string;
  currency: string;
  yahooSymbol: string | null;
  sector?: string | null;
}

export type StockQuoteDto =
  | {
      degraded: false;
      price: number;
      change: number;
      changePct: number;
      currency: string;
      marketState: string;
      asOf: string;
    }
  | { degraded: true; reason: string };

export type StockProfileDto =
  | {
      degraded: false;
      marketCap?: number;
      sector?: string;
      industry?: string;
      nextEarningsDate?: string;
    }
  | { degraded: true; reason: string };

export interface StockDetailResult {
  stock: StockDtoBrief | null;
  quote: StockQuoteDto | null;
  profile: StockProfileDto | null;
  candidates: StockSearchResult[];
}

export async function getStockDetail(
  symbol: string,
  market: string,
): Promise<StockDetailResult> {
  return fetchApi(
    `/api/stocks/${encodeURIComponent(symbol)}?market=${encodeURIComponent(market)}`,
  );
}


// Watchlist APIs
export async function getWatchlist(): Promise<WatchlistItemDto[]> {
  return fetchApi('/api/watchlist');
}

export async function addToWatchlist(
  stock: StockSearchResult,
  notes?: string,
): Promise<WatchlistItemDto> {
  return fetchApi('/api/watchlist', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders(),
    },
    body: JSON.stringify({ ...stock, notes }),
  });
}

export async function updateWatchlistItem(
  id: string,
  notes: string,
): Promise<WatchlistItemDto> {
  return fetchApi(`/api/watchlist/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders(),
    },
    body: JSON.stringify({ notes }),
  });
}

export async function removeFromWatchlist(id: string): Promise<{ ok: boolean }> {
  return fetchApi(`/api/watchlist/${id}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  });
}

// Analysis APIs
export interface AnalysisDto {
  id: string;
  userId: string;
  stockId: string;
  symbol: string;
  market: Market;
  analysisType: AnalysisType;
  question: string | null;
  status: AnalysisStatus;
  aiProvider: string | null;
  aiModel: string | null;
  dataAsOf: string | null;
  generatedAt: string | null;
  overallSignal: Signal | null;
  overallConfidence: Confidence | null;
  degradedSource?: 'WEB_SEARCH_FALLBACK' | null;
  createdAt: string;
  /** Free-form payload; COMPREHENSIVE stores the summary block here. */
  summaryJson?: unknown;
  stock: {
    id: string;
    symbol: string;
    name: string;
    market: Market;
    exchange: string;
    currency: string;
    yahooSymbol: string | null;
  };
  sections: AnalysisSectionDto[];
}

export interface AnalysisSectionDto {
  id: string;
  type: SectionType;
  status: AnalysisStatus;
  reportMarkdown: string | null;
  structuredJson: any;
  citations: any[];
  order: number;
}

export interface AnalysisHistorySectionDto {
  type: SectionType;
  status: AnalysisStatus;
}

export type AnalysisHistoryItemDto = Omit<AnalysisDto, 'sections'> & {
  sections: AnalysisHistorySectionDto[];
};

export async function createAnalysis(
  stockId: string,
  analysisType: ActiveAnalysisType,
  aiProviderSettingId?: string,
  aiModel?: string,
  question?: string,
): Promise<AnalysisDto> {
  const body: Record<string, string> = { stockId, analysisType };
  if (aiProviderSettingId) body.aiProviderSettingId = aiProviderSettingId;
  if (aiModel) body.aiModel = aiModel;
  if (question?.trim()) body.question = question.trim();

  return fetchApi('/api/analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders(),
    },
    body: JSON.stringify(body),
  });
}

export async function getAnalysis(id: string): Promise<AnalysisDto> {
  return fetchApi(`/api/analysis/${id}`);
}

export async function getAnalysisHistory(
  page = 1,
  limit = 20,
  filters?: {
    analysisType?: AnalysisType;
    status?: AnalysisStatus;
    symbol?: string;
    stockId?: string;
    /** Filter to runs where structured evidence fell back to web_search. */
    degradedOnly?: boolean;
  },
): Promise<{
  items: AnalysisHistoryItemDto[];
  total: number;
  page: number;
  limit: number;
}> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (filters?.analysisType) params.set('analysisType', filters.analysisType);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.symbol) params.set('symbol', filters.symbol);
  if (filters?.stockId) params.set('stockId', filters.stockId);
  if (filters?.degradedOnly) params.set('degradedOnly', 'true');
  return fetchApi(`/api/analysis/history?${params.toString()}`);
}

export async function deleteAnalysis(id: string): Promise<{ ok: boolean }> {
  return fetchApi(`/api/analysis/${id}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  });
}

export async function abortAnalysis(id: string): Promise<{ ok: boolean }> {
  return fetchApi(`/api/analysis/${id}/abort`, {
    method: 'POST',
    headers: csrfHeaders(),
  });
}

export async function retrySection(
  analysisId: string,
  sectionId: string,
): Promise<{ ok: boolean }> {
  return fetchApi(`/api/analysis/${analysisId}/sections/${sectionId}/retry`, {
    method: 'POST',
    headers: csrfHeaders(),
  });
}

export type ProviderTypeStr = 'ANTHROPIC' | 'OPENAI_COMPATIBLE';

export interface AiProviderSettingDto {
  id: string;
  label: string;
  providerType: ProviderTypeStr;
  enabledModels: string[];
  primaryModel: string | null;
  utilityModel: string | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderSettingDetailDto extends AiProviderSettingDto {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
}

export interface BuiltinProviderTemplate {
  id: string;
  label: string;
  providerType: ProviderTypeStr;
  baseUrl: string;
  defaultModels: string[];
  iconColor: string;
  iconText: string;
}

export interface AiModelOptionDto {
  id: string;
  name: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface AiProviderSettingInput {
  label: string;
  providerType: ProviderTypeStr;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  enabledModels?: string[];
  primaryModel?: string;
  utilityModel?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export function listAiProviderSettings(): Promise<AiProviderSettingDto[]> {
  return fetchApi('/api/settings/providers');
}

export function createAiProviderSetting(
  data: AiProviderSettingInput,
): Promise<AiProviderSettingDetailDto> {
  return fetchApi('/api/settings/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(data),
  });
}

export function updateAiProviderSetting(
  id: string,
  data: Partial<AiProviderSettingInput>,
): Promise<AiProviderSettingDetailDto> {
  return fetchApi(`/api/settings/providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(data),
  });
}

export function getAiProviderSetting(
  id: string,
): Promise<AiProviderSettingDetailDto> {
  return fetchApi(`/api/settings/providers/${id}`);
}

export function deleteAiProviderSetting(id: string): Promise<{ ok: true }> {
  return fetchApi(`/api/settings/providers/${id}`, {
    method: 'DELETE',
    headers: csrfHeaders(),
  });
}

export function fetchProviderModels(input: {
  providerType: ProviderTypeStr;
  baseUrl: string;
  apiKey?: string;
}, providerId?: string): Promise<AiModelOptionDto[]> {
  const path = providerId
    ? `/api/settings/providers/${providerId}/models`
    : '/api/settings/providers/models';
  return fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(input),
  });
}

export function testProviderConnection(input: {
  providerType: ProviderTypeStr;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}, providerId?: string): Promise<TestConnectionResult> {
  const path = providerId
    ? `/api/settings/providers/${providerId}/test`
    : '/api/settings/providers/test';
  return fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(input),
  });
}

export type WebSearchProviderType = 'TAVILY' | 'SEARXNG';
export type WebSearchPrimaryMode = 'NATIVE_FIRST' | 'CUSTOM_ONLY';

export interface WebSearchSettingDto {
  providerType: WebSearchProviderType;
  apiKeyMasked: string | null;
  baseUrl: string | null;
  primaryMode: WebSearchPrimaryMode;
  timeoutMs: number | null;
  budgetUsdPerRun: number | null;
  cacheTtlMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWebSearchSettingPayload {
  providerType: WebSearchProviderType;
  apiKey?: string;
  baseUrl?: string;
  primaryMode?: WebSearchPrimaryMode;
  timeoutMs?: number;
  budgetUsdPerRun?: number;
  cacheTtlMs?: number;
}

export interface WebSearchTestResult {
  ok: boolean;
  latencyMs: number;
  sample?: { title: string; url: string };
  error?: string;
}

export function getWebSearchSetting(): Promise<WebSearchSettingDto | null> {
  return fetchApi('/api/settings/web-search');
}

export function putWebSearchSetting(
  payload: UpsertWebSearchSettingPayload,
): Promise<WebSearchSettingDto> {
  return fetchApi('/api/settings/web-search', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function deleteWebSearchSetting(): Promise<void> {
  // DELETE returns 204 No Content → can't go through fetchApi (which assumes
  // JSON body), but still need explicit !res.ok handling so 401/403/500
  // surface as ApiError instead of silently no-op'ing while the UI toasts
  // "已删除" and clears local state.
  const res = await fetch(`${API_URL}/api/settings/web-search`, {
    method: 'DELETE',
    credentials: 'include',
    headers: csrfHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message || res.statusText);
  }
}

export function testWebSearchSetting(
  payload: UpsertWebSearchSettingPayload,
): Promise<WebSearchTestResult> {
  return fetchApi('/api/settings/web-search/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(payload),
  });
}

// ============================================================================
// Daily Brief subscription（docs/prd-daily-brief.md · task4 后端）
// 单条 per-user 整体替换（PUT 语义，同 web-search-settings）。channels 的
// 敏感字段（secret/botToken）在后端已 mask，前端拿不到真凭证；编辑时留空 =
// keep-existing（后端 mergeSecrets 处理）。
// ============================================================================

// Market / DigestSession / ChannelType 从 @bourse/shared-types 复用（与 Prisma
// enum 同源），单一来源。别名保留以减少 digest-card 等消费方的 import 改动。
export type DigestMarket = Market;
export type { DigestSession };
export type DigestChannelType = ChannelType;

export type DigestChannel =
  | { type: 'WEBHOOK'; url: string; secret: string }
  | { type: 'FEISHU'; url: string; secret?: string }
  | { type: 'DINGTALK'; url: string; secret: string }
  | { type: 'WECOM'; url: string }
  | { type: 'TELEGRAM'; botToken: string; chatId: string }
  | { type: 'SLACK'; url: string };

export interface DigestSubscriptionDto {
  markets: DigestMarket[];
  sessions: DigestSession[];
  /** 后端 mask 过的 channels（secret/botToken 显示 •••• 末四位）。 */
  channels: DigestChannel[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDigestSubscriptionPayload {
  markets: DigestMarket[];
  sessions: DigestSession[];
  /** 真凭证（新建）或 mask 形态（编辑 keep-existing）。 */
  channels: DigestChannel[];
  enabled?: boolean;
}

export function getDigestSubscription(): Promise<DigestSubscriptionDto | null> {
  return fetchApi('/api/digest/subscription');
}

export function putDigestSubscription(
  payload: UpsertDigestSubscriptionPayload,
): Promise<DigestSubscriptionDto> {
  return fetchApi('/api/digest/subscription', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(payload),
  });
}

export async function deleteDigestSubscription(): Promise<void> {
  // DELETE 204 No Content（同 deleteWebSearchSetting，绕过 fetchApi 的 JSON 假设）。
  const res = await fetch(`${API_URL}/api/digest/subscription`, {
    method: 'DELETE',
    credentials: 'include',
    headers: csrfHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message || res.statusText);
  }
}
