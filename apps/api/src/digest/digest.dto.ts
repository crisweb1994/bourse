import { IsArray, IsBoolean, IsOptional } from 'class-validator';

export const DIGEST_MARKETS = ['US', 'CN', 'HK'] as const;
export type DigestMarket = (typeof DIGEST_MARKETS)[number];

export const DIGEST_SESSIONS = ['PRE', 'POST'] as const;
export type DigestSession = (typeof DIGEST_SESSIONS)[number];

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
  markets!: string[];

  @IsArray()
  sessions!: string[];

  @IsArray()
  channels!: unknown[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** GET / PUT response. channels 的敏感字段（secret/botToken）已 mask。 */
export interface DigestSubscriptionDto {
  markets: string[];
  sessions: string[];
  channels: unknown[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
