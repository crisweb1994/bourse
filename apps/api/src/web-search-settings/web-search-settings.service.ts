import { Injectable, Logger } from '@nestjs/common';
import { buildWebSearchExecutorFromSetting } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import {
  TestWebSearchSettingDto,
  UpsertWebSearchSettingDto,
  WebSearchSettingDto,
  WebSearchTestResult,
} from './web-search-settings.dto';

/**
 * Per-user web search configuration (plan-v2 §17.4.4 — reinstated table).
 * One row per user (uniqueness enforced at schema level). Empty / absent
 * row means "fall through to env (TAVILY_API_KEY / SEARXNG_BASE_URL / ...)
 * or provider native".
 */
@Injectable()
export class WebSearchSettingsService {
  private readonly logger = new Logger(WebSearchSettingsService.name);

  constructor(private prisma: PrismaService) {}

  async get(userId: string): Promise<WebSearchSettingDto | null> {
    const row = await this.prisma.webSearchSetting.findUnique({
      where: { userId },
    });
    return row ? this.toDto(row) : null;
  }

  async upsert(
    userId: string,
    dto: UpsertWebSearchSettingDto,
  ): Promise<WebSearchSettingDto> {
    // Load the existing row first so we can support "keep existing key/baseUrl"
    // semantics when the field is omitted (or empty) from the request. The
    // frontend masks the real key as `tvly-••••JK9F` and submits "" for the
    // key input when the user wants to change primaryMode only; without this
    // pre-load the validator would reject `TAVILY without apiKey`.
    const existing = await this.prisma.webSearchSetting.findUnique({
      where: { userId },
    });
    const apiKey =
      dto.apiKey?.trim() ||
      (existing?.providerType === dto.providerType ? existing.apiKey : null);
    const baseUrl =
      dto.baseUrl?.trim() ||
      (existing?.providerType === dto.providerType ? existing.baseUrl : null);

    this.validateProviderShape({ ...dto, apiKey, baseUrl });

    const data = {
      providerType: dto.providerType,
      apiKey,
      baseUrl,
      primaryMode: dto.primaryMode ?? existing?.primaryMode ?? 'NATIVE_FIRST',
      timeoutMs: dto.timeoutMs ?? existing?.timeoutMs ?? null,
      budgetUsdPerRun: dto.budgetUsdPerRun ?? existing?.budgetUsdPerRun ?? null,
      cacheTtlMs: dto.cacheTtlMs ?? existing?.cacheTtlMs ?? null,
    };
    const row = await this.prisma.webSearchSetting.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.toDto(row);
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.webSearchSetting
      .delete({ where: { userId } })
      .catch(() => undefined);
  }

  /**
   * Stateless: run a single sample query against the supplied config
   * without persisting. Lets the UI verify "is this API key valid" before
   * the user clicks Save.
   *
   * Validation errors are folded into `{ok: false, error}` (same shape as
   * executor failures) instead of throwing — "测试连接" semantically returns
   * a test result; surfacing 500 InternalServerError for "你忘填 apiKey"
   * is hostile UX.
   */
  async test(dto: TestWebSearchSettingDto): Promise<WebSearchTestResult> {
    try {
      this.validateProviderShape(dto);
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // buildWebSearchExecutorFromSetting → buildAdapterFromConfig throws on
    // malformed input (unknown providerId, missing required field for the
    // chosen adapter). validateProviderShape above already covers the
    // common cases, but the registry's exhaustive-check branch is reachable
    // when providerType is a brand-new enum value not yet wired here.
    // Either way, surface it as a test failure, not a 500.
    let executor;
    try {
      executor = buildWebSearchExecutorFromSetting({
        providerType: dto.providerType.toLowerCase() as 'tavily' | 'searxng',
        ...(dto.apiKey ? { apiKey: dto.apiKey } : {}),
        ...(dto.baseUrl ? { baseUrl: dto.baseUrl } : {}),
        ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
        ...(dto.budgetUsdPerRun !== undefined
          ? { budgetUsdPerRun: dto.budgetUsdPerRun }
          : {}),
        ...(dto.cacheTtlMs !== undefined ? { cacheTtlMs: dto.cacheTtlMs } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!executor) {
      return { ok: false, latencyMs: 0, error: 'Adapter not built (config invalid?)' };
    }
    const startedAt = Date.now();
    try {
      const out = await executor.execute({ query: 'Apple stock latest news' });
      const latencyMs = Date.now() - startedAt;
      if (out.error) {
        return { ok: false, latencyMs, error: out.error.message };
      }
      const first = out.output.results.items[0];
      return {
        ok: true,
        latencyMs,
        ...(first ? { sample: { title: first.title, url: first.url } } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Internal — used by ProviderResolverService to load the row (with real apiKey)
   * for executor construction. Not exposed via HTTP.
   */
  async getInternalForRuntime(userId: string) {
    return this.prisma.webSearchSetting.findUnique({ where: { userId } });
  }

  private validateProviderShape(dto: {
    providerType: UpsertWebSearchSettingDto['providerType'];
    apiKey?: string | null;
    baseUrl?: string | null;
  }) {
    if (dto.providerType === 'TAVILY' && !dto.apiKey?.toString().trim()) {
      throw new Error('Tavily requires apiKey');
    }
    if (dto.providerType === 'SEARXNG' && !dto.baseUrl?.toString().trim()) {
      throw new Error('SearXNG requires baseUrl');
    }
  }

  private toDto(row: {
    providerType: string;
    apiKey: string | null;
    baseUrl: string | null;
    primaryMode: string;
    timeoutMs: number | null;
    budgetUsdPerRun: { toNumber: () => number } | null;
    cacheTtlMs: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): WebSearchSettingDto {
    return {
      providerType: row.providerType as WebSearchSettingDto['providerType'],
      apiKeyMasked: maskApiKey(row.apiKey),
      baseUrl: row.baseUrl,
      primaryMode: row.primaryMode as WebSearchSettingDto['primaryMode'],
      timeoutMs: row.timeoutMs,
      budgetUsdPerRun: row.budgetUsdPerRun?.toNumber() ?? null,
      cacheTtlMs: row.cacheTtlMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Mask all but the last 4 chars of a key. Returns null when no key. */
function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  const tail = key.slice(-4);
  const head = key.startsWith('tvly-') ? 'tvly-' : '';
  return `${head}${'•'.repeat(8)}${tail}`;
}
