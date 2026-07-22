import { IsArray, IsBoolean, IsOptional } from 'class-validator';
import { Market, DigestSession } from '@bourse/shared-types';

// Market / DigestSession 单一来源：@bourse/shared-types（mirror Prisma enum）。
// 这里的运行时数组用于 service 内的 markets/sessions 校验（zod.enum 已在
// ChannelConfig 严验，markets/sessions 是 enum 数组，class-validator 不便表达
// enum 元素，故 service 内 .includes 兜底）。
export const DIGEST_MARKETS: readonly Market[] = ['US', 'CN', 'HK'];
export const DIGEST_SESSIONS: readonly DigestSession[] = ['PRE', 'POST'];

/**
 * Upsert payload — PUT /api/digest/subscription. 单条 per-user 整体替换
 * （与 web-search-settings 一致）。
 *
 * channels 此处只粗验 IsArray：元素是 discriminated union（飞书/TG/钉钉…各
 * 字段不同），class-validator 不好表达；service 内用 ChannelConfig.array()
 * (zod, from @bourse/analysis) 严验 + 凭证 keep-existing。
 */
export class UpsertDigestSubscriptionDto {
  @IsArray()
  markets!: Market[];

  @IsArray()
  sessions!: DigestSession[];

  @IsArray()
  channels!: unknown[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  earningsImmediateEnabled?: boolean;
}

/** GET / PUT response. channels 的敏感字段（secret/botToken）已 mask。 */
export interface DigestSubscriptionDto {
  markets: Market[];
  sessions: DigestSession[];
  channels: unknown[];
  enabled: boolean;
  earningsImmediateEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
