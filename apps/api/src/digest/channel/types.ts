import type { BriefPayload, ChannelConfig } from '@bourse/analysis';

/**
 * Daily Brief 推送通道抽象（PRD DB.6）。
 *
 * 每个 adapter 只负责一件事：把 BriefPayload 格式化成各平台的消息体并发出去。
 * **不碰** DB、不碰重试、不碰 DeliveryRecord——那些是 DigestDeliveryService 的职责
 * （统一重试 + 记录，避免每个 adapter 重复实现）。
 *
 * D13 截断（异动 + 大盘优先）是格式化的一部分，在 adapter 内做：非异动票折叠/省略，
 * 卡片放 = 大盘段 + 自选聚合解读 + 异动票（含深入）。
 *
 * 所有按钮均为跳转 URL（单向，无回调）。新增 IM = 加一个 adapter + 注册到
 * CHANNEL_ADAPTERS。
 */
export interface ChannelAdapter {
  /** 渠道类型，与 ChannelConfig 的 discriminated union 一致。 */
  readonly type: ChannelConfig['type'];
  /**
   * 发送一条 brief。返回 HTTP status（2xx 视为成功）。adapter 只在「格式化 + HTTP」
   * 这一层；非 2xx / 网络错误由上层 DeliveryService 重试 3 次。
   */
  send(
    payload: BriefPayload,
    channel: Extract<ChannelConfig, { type: ChannelConfig['type'] }>,
  ): Promise<{ httpStatus: number }>;
}

/**
 * 通用脱敏：用于 DeliveryRecord.target（PRD §8.2「url 域名 / chatId 末四位」）。
 * 不把完整凭证写进投递记录，避免备份外发泄露（IM 凭证明文落库属 Phase 2 加密）。
 */
export function maskTarget(channel: ChannelConfig): string {
  switch (channel.type) {
    case 'TELEGRAM':
      return `tg:${channel.chatId.slice(-4)}`;
    case 'WEBHOOK':
    case 'FEISHU':
    case 'DINGTALK':
    case 'SLACK':
    case 'WECOM':
      // 所有 incoming-webhook 类渠道：脱敏到域名。
      return hostOf(channel.url);
    default: {
      // exhaustiveness guard
      const _exhaustive: never = channel;
      return String(_exhaustive);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
