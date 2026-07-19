import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  AiProviderSettingDetailDto,
  AiProviderSettingSummaryDto,
  CreateAiProviderSettingDto,
  ProviderTypeStr,
  UpdateAiProviderSettingDto,
} from './ai-settings.dto';

import { BUILTIN_PROVIDER_CATALOG } from './builtin-catalog';

export interface AiProviderRuntime {
  id: string;
  providerType: ProviderTypeStr;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  utilityModel: string | null;
}

const ANTHROPIC_STATIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

const CREDENTIAL_CIPHER_VERSION = 'v1';
const CREDENTIAL_IV_BYTES = 12;

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);
  private credentialsKey: Buffer | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  getCatalog() {
    return BUILTIN_PROVIDER_CATALOG;
  }

  async list(userId: string): Promise<AiProviderSettingSummaryDto[]> {
    const rows = await this.prisma.aiProviderSetting.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toSummaryDto(r));
  }

  async get(userId: string, id: string): Promise<AiProviderSettingDetailDto> {
    return this.toDetailDto(await this.ensureOwned(userId, id));
  }

  async create(userId: string, dto: CreateAiProviderSettingDto): Promise<AiProviderSettingDetailDto> {
    const apiKey = dto.apiKey?.trim() || null;
    this.assertModelInEnabled('primaryModel', dto.primaryModel, dto.enabledModels);
    this.assertModelInEnabled('utilityModel', dto.utilityModel, dto.enabledModels);
    const data = {
      userId,
      label: dto.label.trim() || '未命名',
      providerType: dto.providerType,
      baseUrl: this.emptyToNull(dto.baseUrl),
      apiKey: null,
      apiKeyEncrypted: apiKey ? this.encryptApiKey(apiKey) : null,
      enabledModels: dto.enabledModels ?? [],
      primaryModel: this.emptyToNull(dto.primaryModel),
      utilityModel: this.emptyToNull(dto.utilityModel),
      isDefault: dto.isDefault ?? false,
      enabled: dto.enabled ?? true,
    };

    if (data.isDefault) await this.clearDefault(userId);

    // 若用户当前没有任何 isDefault，自动把新建这条设为 default
    if (!data.isDefault) {
      const hasDefault = await this.prisma.aiProviderSetting.findFirst({
        where: { userId, isDefault: true },
        select: { id: true },
      });
      if (!hasDefault) data.isDefault = true;
    }

    const row = await this.prisma.aiProviderSetting.create({ data });
    return this.toDetailDto(row);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateAiProviderSettingDto,
  ): Promise<AiProviderSettingDetailDto> {
    const existing = await this.ensureOwned(userId, id);

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label.trim() || existing.label || '未命名';
    if (dto.providerType !== undefined) data.providerType = dto.providerType;
    if (dto.baseUrl !== undefined) data.baseUrl = this.emptyToNull(dto.baseUrl);
    if (dto.enabledModels !== undefined) data.enabledModels = dto.enabledModels;
    // Validate primary/utility against the **effective** enabledModels (the
    // patch's value if provided, else the existing row's). Prevents users
    // from pointing at a model they just removed.
    const effectiveEnabled = dto.enabledModels ?? existing.enabledModels;
    if (dto.primaryModel !== undefined) {
      this.assertModelInEnabled('primaryModel', dto.primaryModel, effectiveEnabled);
      data.primaryModel = this.emptyToNull(dto.primaryModel);
    }
    if (dto.utilityModel !== undefined) {
      this.assertModelInEnabled('utilityModel', dto.utilityModel, effectiveEnabled);
      data.utilityModel = this.emptyToNull(dto.utilityModel);
    }
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    if (dto.clearApiKey === true) {
      data.apiKey = null;
      data.apiKeyEncrypted = null;
    } else if (dto.apiKey !== undefined) {
      const apiKey = dto.apiKey.trim() || null;
      data.apiKey = null;
      data.apiKeyEncrypted = apiKey ? this.encryptApiKey(apiKey) : null;
    }

    if (dto.isDefault === true) {
      await this.clearDefault(userId);
      data.isDefault = true;
    } else if (dto.isDefault === false) {
      data.isDefault = false;
    }

    const row = await this.prisma.aiProviderSetting.update({ where: { id }, data });
    return this.toDetailDto(row);
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    const existing = await this.ensureOwned(userId, id);
    await this.prisma.aiProviderSetting.delete({ where: { id } });

    // 如果删的是默认，从剩余 enabled 项里挑一个设为 default
    if (existing.isDefault) {
      const next = await this.prisma.aiProviderSetting.findFirst({
        where: { userId, enabled: true },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await this.prisma.aiProviderSetting.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    return { ok: true };
  }

  async listModelsStateless(input: {
    providerType: ProviderTypeStr;
    baseUrl: string;
    apiKey?: string;
  }): Promise<{ id: string; name: string }[]> {
    if (input.providerType === 'ANTHROPIC') {
      return ANTHROPIC_STATIC_MODELS.map((m) => ({ id: m, name: m }));
    }
    const baseUrl = (input.baseUrl || '').trim();
    if (!baseUrl) {
      throw new BadRequestException('Base URL is required to fetch models');
    }
    const apiKey = (input.apiKey || '').trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const url = this.joinUrl(baseUrl, '/models');
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (err: any) {
      throw new BadGatewayException(`Fetch /models failed: ${err.message}`);
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      const detail = text ? ` — ${text}` : '';
      const hint =
        response.status === 401 || response.status === 403
          ? '上游 Provider 拒绝授权 — API Key 无效 / 过期 / 无该 endpoint 权限'
          : '上游 Provider 返回错误';
      // 把上游 401/403 透传为本地 401，避免被当成网关挂掉
      if (response.status === 401 || response.status === 403) {
        throw new UnauthorizedException(`${hint}（HTTP ${response.status}）${detail}`);
      }
      throw new HttpException(
        `${hint}（HTTP ${response.status}）${detail}`,
        502,
      );
    }
    const body: any = await response.json().catch(() => ({}));
    const data = Array.isArray(body?.data) ? body.data : [];
    return data
      .map((m: any) => {
        const mid = typeof m?.id === 'string' ? m.id : null;
        if (!mid) return null;
        return { id: mid, name: m.name || mid };
      })
      .filter(Boolean) as { id: string; name: string }[];
  }

  async listModelsForSaved(
    userId: string,
    id: string,
    input: { providerType: ProviderTypeStr; baseUrl: string; apiKey?: string },
  ) {
    const row = await this.ensureOwned(userId, id);
    const savedApiKey = await this.readApiKey(row);
    return this.listModelsStateless({
      ...input,
      apiKey: input.apiKey?.trim() || savedApiKey || undefined,
    });
  }

  /**
   * 无状态测试连接 — 不依赖 DB 行，直接用入参拨打。允许用户在新建中、未保存
   * 时也能立刻验证 baseUrl + key + model 是否好用。
   */
  async testConnectionStateless(input: {
    providerType: ProviderTypeStr;
    apiKey: string;
    baseUrl?: string;
    model: string;
  }): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const apiKey = (input.apiKey || '').trim();
    if (!apiKey) {
      return { ok: false, latencyMs: 0, error: 'API Key is empty（请填写后再测试）' };
    }
    const model = (input.model || '').trim();
    if (!model) {
      return { ok: false, latencyMs: 0, error: 'No model configured（启用至少一个模型）' };
    }
    const providerType = input.providerType;
    const baseUrl = (input.baseUrl || '').trim();

    const started = Date.now();
    try {
      if (providerType === 'ANTHROPIC') {
        const url = this.joinUrl(baseUrl || 'https://api.anthropic.com', '/v1/messages');
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        const latencyMs = Date.now() - started;
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          return { ok: false, latencyMs, error: `HTTP ${r.status} ${text.slice(0, 200)}` };
        }
        return { ok: true, latencyMs };
      } else {
        if (!baseUrl) return { ok: false, latencyMs: 0, error: 'Base URL is empty' };
        const url = this.joinUrl(baseUrl, '/chat/completions');
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        const latencyMs = Date.now() - started;
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          return { ok: false, latencyMs, error: `HTTP ${r.status} ${text.slice(0, 200)}` };
        }
        return { ok: true, latencyMs };
      }
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  }

  async testConnectionForSaved(
    userId: string,
    id: string,
    input: {
      providerType: ProviderTypeStr;
      apiKey?: string;
      baseUrl?: string;
      model: string;
    },
  ) {
    const row = await this.ensureOwned(userId, id);
    const savedApiKey = await this.readApiKey(row);
    return this.testConnectionStateless({
      ...input,
      apiKey: input.apiKey?.trim() || savedApiKey || '',
    });
  }

  /**
   * 智能拼路径：避免 baseUrl 已经包含 path 段时被重复追加。
   *   joinUrl('https://api.deepseek.com/v1', '/chat/completions')      → .../v1/chat/completions
   *   joinUrl('https://api.anthropic.com',   '/v1/messages')           → .../v1/messages
   *   joinUrl('https://api.anthropic.com/v1','/v1/messages')           → .../v1/messages  (不重复 /v1)
   */
  private joinUrl(base: string, suffix: string): string {
    const cleanBase = base.replace(/\/+$/, '');
    const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    // 如果 suffix 的第一段已经是 base 的末尾段，删掉重复
    const suffixHead = cleanSuffix.split('/').filter(Boolean)[0] || '';
    if (suffixHead && cleanBase.endsWith(`/${suffixHead}`)) {
      return cleanBase + cleanSuffix.slice(cleanSuffix.indexOf('/', 1));
    }
    return cleanBase + cleanSuffix;
  }

  async getRuntimeById(userId: string, id: string): Promise<AiProviderRuntime | null> {
    const row = await this.prisma.aiProviderSetting.findFirst({
      where: { id, userId },
    });
    if (!row || !row.enabled || !row.providerType) return null;
    return this.toRuntime(row);
  }

  async getDefaultRuntime(userId: string): Promise<AiProviderRuntime | null> {
    const row = await this.prisma.aiProviderSetting.findFirst({
      where: { userId, isDefault: true, enabled: true },
    });
    if (!row || !row.providerType) return null;
    return this.toRuntime(row);
  }

  // ===== internals =====

  private async ensureOwned(userId: string, id: string) {
    const row = await this.prisma.aiProviderSetting.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Provider setting not found');
    return row;
  }

  private async clearDefault(userId: string) {
    await this.prisma.aiProviderSetting.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
  }

  private async toRuntime(row: any): Promise<AiProviderRuntime> {
    return {
      id: row.id,
      providerType: row.providerType,
      apiKey: await this.readApiKey(row),
      baseUrl: row.baseUrl,
      model: row.primaryModel ?? row.enabledModels[0] ?? null,
      utilityModel: row.utilityModel ?? null,
    };
  }

  private toSummaryDto(row: any): AiProviderSettingSummaryDto {
    return {
      id: row.id,
      label: row.label ?? '未命名',
      providerType: row.providerType ?? 'OPENAI_COMPATIBLE',
      enabledModels: row.enabledModels ?? [],
      primaryModel: row.primaryModel ?? null,
      utilityModel: row.utilityModel ?? null,
      isDefault: row.isDefault ?? false,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async toDetailDto(row: any): Promise<AiProviderSettingDetailDto> {
    const apiKey = await this.readApiKey(row);
    return {
      ...this.toSummaryDto(row),
      baseUrl: row.baseUrl ?? '',
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: apiKey ? `****${apiKey.slice(-4)}` : null,
    };
  }

  private async readApiKey(row: any): Promise<string | null> {
    if (row.apiKeyEncrypted) {
      const decrypted = this.decryptApiKey(row.apiKeyEncrypted);
      if (decrypted.usedJwtFallback) {
        await this.prisma.aiProviderSetting.updateMany({
          where: {
            id: row.id,
            apiKeyEncrypted: row.apiKeyEncrypted,
          },
          data: {
            apiKey: null,
            apiKeyEncrypted: this.encryptApiKey(decrypted.apiKey),
          },
        });
      }
      return decrypted.apiKey;
    }

    const legacyApiKey = row.apiKey?.trim() || null;
    if (!legacyApiKey) return null;

    const apiKeyEncrypted = this.encryptApiKey(legacyApiKey);
    await this.prisma.aiProviderSetting.updateMany({
      where: {
        id: row.id,
        apiKey: legacyApiKey,
        apiKeyEncrypted: null,
      },
      data: {
        apiKey: null,
        apiKeyEncrypted,
      },
    });
    return legacyApiKey;
  }

  private encryptApiKey(apiKey: string): string {
    const iv = randomBytes(CREDENTIAL_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.getCredentialsKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      CREDENTIAL_CIPHER_VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  private decryptApiKey(payload: string): { apiKey: string; usedJwtFallback: boolean } {
    const [version, ivEncoded, authTagEncoded, ciphertextEncoded, ...extra] = payload.split(':');
    if (
      version !== CREDENTIAL_CIPHER_VERSION ||
      !ivEncoded ||
      !authTagEncoded ||
      !ciphertextEncoded ||
      extra.length > 0
    ) {
      throw new InternalServerErrorException(
        'Stored AI credential has an unsupported or invalid format',
      );
    }

    const iv = Buffer.from(ivEncoded, 'base64url');
    const authTag = Buffer.from(authTagEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    for (const candidate of this.getCredentialDecryptionKeys()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', candidate.key, iv);
        decipher.setAuthTag(authTag);
        const apiKey = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8');
        return { apiKey, usedJwtFallback: candidate.usedJwtFallback };
      } catch {
        // Authentication failure means this ciphertext belongs to another key candidate.
      }
    }

    throw new InternalServerErrorException(
      'Unable to decrypt stored AI credential; verify AI_CREDENTIALS_ENCRYPTION_KEY',
    );
  }

  private getCredentialsKey(): Buffer {
    if (this.credentialsKey) return this.credentialsKey;

    const dedicatedSecret = this.config.get<string>('AI_CREDENTIALS_ENCRYPTION_KEY')?.trim();
    const jwtSecret = this.config.get<string>('JWT_SECRET')?.trim();
    const secret = dedicatedSecret || jwtSecret;
    if (!secret) {
      throw new InternalServerErrorException(
        'AI credential encryption is not configured; set AI_CREDENTIALS_ENCRYPTION_KEY',
      );
    }
    if (!dedicatedSecret) {
      this.logger.warn(
        'AI_CREDENTIALS_ENCRYPTION_KEY is not set; using JWT_SECRET for credential encryption',
      );
    }
    this.credentialsKey = createHash('sha256').update(secret, 'utf8').digest();
    return this.credentialsKey;
  }

  private getCredentialDecryptionKeys(): Array<{ key: Buffer; usedJwtFallback: boolean }> {
    const dedicatedSecret = this.config.get<string>('AI_CREDENTIALS_ENCRYPTION_KEY')?.trim();
    const jwtSecret = this.config.get<string>('JWT_SECRET')?.trim();
    if (!dedicatedSecret && !jwtSecret) {
      throw new InternalServerErrorException(
        'AI credential encryption is not configured; set AI_CREDENTIALS_ENCRYPTION_KEY',
      );
    }

    const candidates: Array<{ key: Buffer; usedJwtFallback: boolean }> = [];
    if (dedicatedSecret) {
      candidates.push({
        key: createHash('sha256').update(dedicatedSecret, 'utf8').digest(),
        usedJwtFallback: false,
      });
    }
    if (jwtSecret && jwtSecret !== dedicatedSecret) {
      candidates.push({
        key: createHash('sha256').update(jwtSecret, 'utf8').digest(),
        usedJwtFallback: Boolean(dedicatedSecret),
      });
    }
    return candidates;
  }

  private emptyToNull(value?: string | null): string | null {
    if (value == null) return null;
    const t = value.trim();
    return t ? t : null;
  }

  private assertModelInEnabled(
    field: 'primaryModel' | 'utilityModel',
    value: string | undefined | null,
    enabled: string[] | undefined,
  ): void {
    const v = (value ?? '').trim();
    if (!v) return; // empty is allowed; fallback rules apply
    const list = enabled ?? [];
    if (!list.includes(v)) {
      throw new BadRequestException(
        `${field}="${v}" 必须在 enabledModels 中（当前候选: ${list.join(', ') || '空'}）`,
      );
    }
  }
}
