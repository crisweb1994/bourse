import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { buildWebSearchExecutorFromSetting } from '@bourse/analysis';
import {
  credentialEncryptionKey,
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from '../common/credentials-crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  TestWebSearchSettingDto,
  UpsertWebSearchSettingDto,
  WebSearchSettingDto,
  WebSearchTestResult,
} from './web-search-settings.dto';

/** Per-user web search adapter configuration. An absent row uses provider-native search or deployment env defaults. */

/** Client-fixable shape violation (e.g. TAVILY without apiKey). Infrastructure errors are not this. */
export class ProviderShapeError extends Error {}

@Injectable()
export class WebSearchSettingsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

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
    // existing.apiKey 在库中为密文（v1:…）；merge 语义只做透传，不参与形状校验。
    const apiKey =
      dto.apiKey?.trim() ||
      (existing?.providerType === dto.providerType ? existing.apiKey : null);
    const baseUrl =
      dto.baseUrl?.trim() ||
      (existing?.providerType === dto.providerType ? existing.baseUrl : null);

    this.validateProviderShape({ ...dto, apiKey, baseUrl });

    const data = {
      providerType: dto.providerType,
      apiKey:
        apiKey && !isEncryptedCredential(apiKey)
          ? encryptCredential(credentialEncryptionKey(this.config), apiKey)
          : apiKey,
      baseUrl,
      primaryMode: dto.primaryMode ?? existing?.primaryMode ?? 'NATIVE_FIRST',
      timeoutMs: dto.timeoutMs ?? existing?.timeoutMs ?? null,
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
    try {
      await this.prisma.webSearchSetting.delete({ where: { userId } });
    } catch (err) {
      // P2025 = record not found; delete is idempotent. Anything else is real.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        return;
      }
      throw err;
    }
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
    let executor;
    try {
      executor = buildWebSearchExecutorFromSetting({
        providerType: dto.providerType.toLowerCase() as 'tavily' | 'searxng',
        ...(dto.apiKey ? { apiKey: dto.apiKey } : {}),
        ...(dto.baseUrl ? { baseUrl: dto.baseUrl } : {}),
        ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
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
    const row = await this.prisma.webSearchSetting.findUnique({ where: { userId } });
    return row ? { ...row, apiKey: this.readApiKey(row.apiKey) } : row;
  }

  /** 库内密文 → 明文；非密文形态（空/历史明文）原样返回。 */
  private readApiKey(stored: string | null): string | null {
    if (!stored || !isEncryptedCredential(stored)) return stored;
    return decryptCredential(credentialEncryptionKey(this.config), stored);
  }

  private validateProviderShape(dto: {
    providerType: UpsertWebSearchSettingDto['providerType'];
    apiKey?: string | null;
    baseUrl?: string | null;
  }) {
    if (dto.providerType === 'TAVILY' && !dto.apiKey?.toString().trim()) {
      throw new ProviderShapeError('Tavily requires apiKey');
    }
    if (dto.providerType === 'SEARXNG' && !dto.baseUrl?.toString().trim()) {
      throw new ProviderShapeError('SearXNG requires baseUrl');
    }
  }

  private toDto(row: {
    providerType: string;
    apiKey: string | null;
    baseUrl: string | null;
    primaryMode: string;
    timeoutMs: number | null;
    cacheTtlMs: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): WebSearchSettingDto {
    return {
      providerType: row.providerType as WebSearchSettingDto['providerType'],
      apiKeyMasked: maskApiKey(this.readApiKey(row.apiKey)),
      baseUrl: row.baseUrl,
      primaryMode: row.primaryMode as WebSearchSettingDto['primaryMode'],
      timeoutMs: row.timeoutMs,
      cacheTtlMs: row.cacheTtlMs,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
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
