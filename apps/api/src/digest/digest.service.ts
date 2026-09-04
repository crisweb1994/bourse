import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelConfig } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIGEST_MARKETS,
  type UpsertDigestSubscriptionDto,
} from './digest.dto';

/**
 * Daily Brief 订阅 CRUD（docs/prd-daily-brief.md）。
 * 单条 per-user（userId unique）。channels 存 ChannelConfig[] JSON
 * （凭证明文，产品决策：不做静态加密）。
 * 完整简报不落库（v1.4）——这里只管订阅配置 + 投递记录（DeliveryRecord）。
 */
@Injectable()
export class DigestSubscriptionService {
  constructor(private prisma: PrismaService) {}

  /** GET — 返回订阅，channels 敏感字段已 mask。null = 未订阅。 */
  async get(userId: string) {
    const row = await this.prisma.digestSubscription.findUnique({
      where: { userId },
    });
    return row ? this.toPublic(row) : null;
  }

  /** PUT — 整体替换；markets 枚举校验 + channels zod 严验 +
   *  敏感字段空/mask 形态时保留旧值（前端拿不到真凭证）。 */
  async upsert(userId: string, dto: UpsertDigestSubscriptionDto) {
    for (const m of dto.markets) {
      if (!DIGEST_MARKETS.includes(m as (typeof DIGEST_MARKETS)[number])) {
        throw new BadRequestException(`invalid market: ${m}`);
      }
    }

    const existing = await this.prisma.digestSubscription.findUnique({
      where: { userId },
    });
    const existingChannels = (existing?.channels ?? []) as ChannelConfig[];
    const merged = mergeSecrets(dto.channels, existingChannels);

    const parsed = ChannelConfig.array().safeParse(merged);
    if (!parsed.success) {
      throw new BadRequestException(
        `invalid channels: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const enabled = dto.enabled ?? true;
    const earningsImmediateEnabled = dto.earningsImmediateEnabled ?? false;
    const channels = parsed.data;
    const row = await this.prisma.digestSubscription.upsert({
      where: { userId },
      create: {
        userId,
        markets: dto.markets,
        channels,
        enabled,
        earningsImmediateEnabled,
      },
      update: {
        markets: dto.markets,
        channels,
        enabled,
        earningsImmediateEnabled,
      },
    });
    return this.toPublic(row);
  }

  /** DELETE — 删订阅(幂等:不存在视为已删,其余错误照常抛)。 */
  async remove(userId: string): Promise<void> {
    try {
      await this.prisma.digestSubscription.delete({ where: { userId } });
    } catch (err) {
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
   * Internal — generator/adapter 读真 channels（凭证已解密，不 mask）。
   * 仅进程内调用，不暴露 HTTP。
   */
  async getInternal(userId: string) {
    return this.prisma.digestSubscription.findUnique({ where: { userId } });
  }

  private toPublic(row: {
    markets: string[];
    channels: unknown;
    enabled: boolean;
    earningsImmediateEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      markets: row.markets,
      channels: (row.channels as ChannelConfig[]).map(maskChannel),
      enabled: row.enabled,
      earningsImmediateEnabled: row.earningsImmediateEnabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** mask 敏感字段，保留末 4 位（与 web-search-settings apiKeyMasked 同风格）。 */
function maskSecret(v: string): string {
  if (!v) return v;
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

function maskChannel(c: ChannelConfig): ChannelConfig {
  switch (c.type) {
    case 'WEBHOOK':
      return { ...c, secret: maskSecret(c.secret) };
    case 'FEISHU':
      return c.secret ? { ...c, secret: maskSecret(c.secret) } : c;
    case 'TELEGRAM':
      return { ...c, botToken: maskSecret(c.botToken) };
  }
}

/**
 * incoming 的 secret/botToken 若为空或 mask 形态（含 •），从 existing 同标识
 * （url / chatId）的 channel 取真值。让前端编辑订阅时无需重输凭证。
 */
function mergeSecrets(incoming: unknown[], existing: ChannelConfig[]): unknown[] {
  return incoming.map((inc) => {
    if (!inc || typeof inc !== 'object') return inc;
    const c = { ...(inc as Record<string, unknown>) };
    const id = (c.url as string) ?? (c.chatId as string);
    const prev = existing.find(
      (e) =>
        (e as Record<string, unknown>).url === id ||
        (e as Record<string, unknown>).chatId === id,
    ) as Record<string, unknown> | undefined;
    if (prev) {
      for (const k of ['secret', 'botToken']) {
        const v = c[k];
        if (v === undefined || v === '' || (typeof v === 'string' && v.includes('•'))) {
          if (prev[k] !== undefined) c[k] = prev[k];
        }
      }
    }
    return c;
  });
}
