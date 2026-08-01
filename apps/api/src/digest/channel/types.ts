import type { BriefPayload, ChannelConfig } from '@bourse/analysis';

/** Credential-free target used by DeliveryRecord and warning logs. */
export { maskChannelTarget as maskTarget } from '../../common/channel-target';

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
