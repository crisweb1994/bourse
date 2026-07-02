import { BadRequestException, Injectable } from '@nestjs/common';
import { ChannelConfig } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIGEST_MARKETS,
  DIGEST_SESSIONS,
  type UpsertDigestSubscriptionDto,
} from './digest.dto';

/**
 * Daily Brief 订阅 CRUD（docs/prd-daily-brief.md）。
 * 单条 per-user（userId unique）。channels 存 ChannelConfig[] JSON。
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

  /** PUT — 整体替换；markets/sessions 枚举校验 + channels zod 严验 +
   *  敏感字段空/mask 形态时保留旧值（前端拿不到真凭证）。 */
  async upsert(userId: string, dto: UpsertDigestSubscriptionDto) {
    for (const m of dto.markets) {
      if (!DIGEST_MARKETS.includes(m as (typeof DIGEST_MARKETS)[number])) {
        throw new BadRequestException(`invalid market: ${m}`);
      }
    }
    for (const s of dto.sessions) {
      if (!DIGEST_SESSIONS.includes(s as (typeof DIGEST_SESSIONS)[number])) {
        throw new BadRequestException(`invalid session: ${s}`);
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
    const row = await this.prisma.digestSubscription.upsert({
      where: { userId },
      create: {
        userId,
        markets: dto.markets,
        sessions: dto.sessions,
        channels: parsed.data,
        enabled,
      },
      update: {
        markets: dto.markets,
        sessions: dto.sessions,
        channels: parsed.data,
        enabled,
      },
    });
    return this.toPublic(row);
  }

  /** DELETE — 删订阅（idempotent，不存在不报错）。 */
  async remove(userId: string): Promise<void> {
    await this.prisma.digestSubscription
      .delete({ where: { userId } })
      .catch(() => undefined);
  }

  /**
   * Internal — generator/adapter 读真 channels（含凭证，不 mask）。
   * 仅进程内调用，不暴露 HTTP。
   */
  async getInternal(userId: string) {
    return this.prisma.digestSubscription.findUnique({ where: { userId } });
  }

  private toPublic(row: {
    markets: string[];
    sessions: string[];
    channels: unknown;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      markets: row.markets,
      sessions: row.sessions,
      channels: (row.channels as ChannelConfig[]).map(maskChannel),
      enabled: row.enabled,
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
    case 'DINGTALK':
      return { ...c, secret: maskSecret(c.secret) };
    case 'TELEGRAM':
      return { ...c, botToken: maskSecret(c.botToken) };
    default:
      return c; // WECOM / SLACK 无敏感字段
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
