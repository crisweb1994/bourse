import { Injectable, Logger } from '@nestjs/common';
import type { EarningsCardPayload, EarningsNoticePayload } from '@bourse/analysis';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EarningsNoticeService {
  private readonly logger = new Logger(EarningsNoticeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notify(
    stockId: string,
    payload: EarningsCardPayload,
    revisionId: string,
    previousRevisionId: string | undefined,
    kind: EarningsNoticePayload['kind'],
  ): Promise<void> {
    const stock = await this.prisma.stock.findUnique({
      where: { id: stockId },
      include: {
        watchlistItems: {
          include: { user: { include: { digestSubscription: true } } },
        },
      },
    });
    if (!stock) return;
    const notice = toNotice(stock, payload, revisionId, previousRevisionId, kind);
    await Promise.allSettled(stock.watchlistItems.map(async (item) => {
      const subscription = item.user.digestSubscription;
      if (
        !subscription
        || !subscription.enabled
        || !subscription.earningsImmediateEnabled
        || !subscription.markets.includes(stock.market as never)
      ) return;
      const channels = Array.isArray(subscription.channels) ? subscription.channels : [];
      await Promise.allSettled(channels.map((channel) => this.send(item.userId, channel, notice)));
    }));
  }

  private async send(userId: string, channel: unknown, notice: EarningsNoticePayload): Promise<void> {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return;
    const config = channel as Record<string, unknown>;
    const type = typeof config.type === 'string' ? config.type : '';
    const target = maskTarget(config);
    const dedupeKey = `${userId}:${notice.revisionId}:${notice.kind}:${type}:${target}`;
    if (!await this.claimDelivery(dedupeKey, userId, config, notice)) return;
    let lastStatus: number | null = null;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        lastStatus = await sendChannel(config, notice);
        if (lastStatus >= 200 && lastStatus < 300) {
          await this.record(dedupeKey, userId, config, notice, 'SENT', lastStatus, null);
          return;
        }
        lastError = `HTTP ${lastStatus}`;
      } catch (error) {
        lastError = String(error);
      }
      if (attempt < 3) await sleep(100 * 4 ** (attempt - 1));
    }
    await this.record(dedupeKey, userId, config, notice, 'FAILED', lastStatus, lastError);
    this.logger.warn(`earnings notice ${notice.symbol} → ${target} failed: ${lastError}`);
  }

  private async claimDelivery(
    dedupeKey: string,
    userId: string,
    channel: Record<string, unknown>,
    notice: EarningsNoticePayload,
  ): Promise<boolean> {
    const now = new Date();
    try {
      await this.prisma.earningsDeliveryRecord.create({
        data: {
          dedupeKey,
          userId,
          stockId: notice.stockId,
          revisionId: notice.revisionId,
          previousRevisionId: notice.previousRevisionId,
          kind: notice.kind,
          channelType: channel.type as never,
          target: maskTarget(channel),
          status: 'RETRYING',
          httpStatus: null,
          error: null,
          attemptedAt: now,
          deliveredAt: null,
        },
      });
      return true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }

    // A fresh RETRYING row belongs to another worker. Reclaim only failures or
    // abandoned claims, so concurrent replicas cannot double-send a notice.
    const staleBefore = new Date(now.getTime() - 5 * 60_000);
    const reclaimed = await this.prisma.earningsDeliveryRecord.updateMany({
      where: {
        dedupeKey,
        OR: [
          { status: 'FAILED' },
          { status: 'RETRYING', attemptedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'RETRYING',
        httpStatus: null,
        error: null,
        attemptedAt: now,
        deliveredAt: null,
      },
    });
    return reclaimed.count === 1;
  }

  private async record(
    dedupeKey: string,
    userId: string,
    channel: Record<string, unknown>,
    notice: EarningsNoticePayload,
    status: 'SENT' | 'FAILED' | 'RETRYING',
    httpStatus: number | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.earningsDeliveryRecord.upsert({
      where: { dedupeKey },
      update: {
        status,
        httpStatus,
        error,
        attemptedAt: new Date(),
        deliveredAt: status === 'SENT' ? new Date() : null,
      },
      create: {
        dedupeKey,
        userId,
        stockId: notice.stockId,
        revisionId: notice.revisionId,
        previousRevisionId: notice.previousRevisionId,
        kind: notice.kind,
        channelType: channel.type as never,
        target: maskTarget(channel),
        status,
        httpStatus,
        error,
        deliveredAt: status === 'SENT' ? new Date() : null,
      },
    });
  }
}

function toNotice(
  stock: { id: string; symbol: string; name: string; market: string },
  payload: EarningsCardPayload,
  revisionId: string,
  previousRevisionId: string | undefined,
  kind: EarningsNoticePayload['kind'],
): EarningsNoticePayload {
  return {
    kind,
    revisionId,
    ...(previousRevisionId ? { previousRevisionId } : {}),
    stockId: stock.id,
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market as EarningsNoticePayload['market'],
    periodEndOn: payload.event.periodEndOn,
    periodType: payload.event.periodType,
    publishedAt: payload.filing.publishedAt,
    generatedAt: payload.generatedAt,
    sourceUrl: payload.filing.sourceUrl,
    statusSummary: payload.statusSummary,
    topFacts: payload.facts.slice(0, 6).map((fact) => ({
      metricCode: fact.metricCode,
      value: fact.normalizedValue ?? fact.value,
      currency: fact.currency,
      unit: fact.unit,
    })),
  };
}

function maskTarget(channel: Record<string, unknown>): string {
  if (channel.type === 'TELEGRAM') return `tg:${String(channel.chatId ?? '').slice(-4)}`;
  try { return new URL(String(channel.url)).host; } catch { return 'invalid-url'; }
}

async function sendChannel(channel: Record<string, unknown>, notice: EarningsNoticePayload): Promise<number> {
  const type = channel.type;
  const text = renderNotice(notice);
  if (type === 'WEBHOOK') {
    const body = JSON.stringify(notice);
    const signature = await hmac(String(channel.secret ?? ''), body);
    const response = await fetch(String(channel.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bourse-Signature': `sha256=${signature}` },
      body,
    });
    return response.status;
  }
  if (type === 'TELEGRAM') {
    const response = await fetch(`https://api.telegram.org/bot${String(channel.botToken)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(channel.chatId), text }),
    });
    return response.status;
  }
  if (type === 'FEISHU') {
    const response = await fetch(String(channel.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    return response.status;
  }
  return 501;
}

function renderNotice(notice: EarningsNoticePayload): string {
  const title = notice.kind === 'CORRECTION' ? '财报更正通知' : notice.kind === 'UPDATE' ? '财报速读更新' : '新财报速读';
  const status = notice.statusSummary.conflicted > 0
    ? `${notice.statusSummary.conflicted} 项冲突`
    : `${notice.statusSummary.reconciled}/${notice.statusSummary.total} 已对账`;
  return [
    `${title} · ${notice.symbol}`,
    `${notice.periodEndOn} · ${notice.periodType} · ${status}`,
    ...notice.topFacts.map((fact) => `- ${fact.metricCode}: ${fact.value.kind === 'scalar' ? fact.value.value : `${fact.value.min}-${fact.value.max}`}`),
    `公告原文：${notice.sourceUrl}`,
  ].join('\n');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Buffer.from(new Uint8Array(sig)).toString('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
