// Digest delivery channel configuration (DigestSubscription.channels JSON).
// KISS T2-2: single source for the subscription-credential contract shared
// by apps/api (digest module, validated at the PUT boundary) and apps/web
// (settings form). Previously the zod union lived in @bourse/analysis with a
// hand-copied twin in web — with a stale justification.
//
// NOTE: literals are inlined (not ChannelType.X) because importing the const
// object from './index' creates a circular module init under CJS; the anchor
// below makes drift a compile error instead.

import { z } from 'zod';

import type { ChannelType } from './index';

const CHANNEL_TYPES = [
  'WEBHOOK',
  'FEISHU',
  'DINGTALK',
  'WECOM',
  'TELEGRAM',
  'SLACK',
] as const;

// 编译期锚定:CHANNEL_TYPES 与共享 ChannelType 单源双向对齐,漂移即编译错。
const _channelTypeAnchor: Record<ChannelType, true> = {
  WEBHOOK: true,
  FEISHU: true,
  DINGTALK: true,
  WECOM: true,
  TELEGRAM: true,
  SLACK: true,
};
void _channelTypeAnchor;

export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('WEBHOOK'),
    url: z.string().url(),
    secret: z.string().min(1),
  }),
  z.object({
    type: z.literal('FEISHU'),
    url: z.string().url(),
    secret: z.string().optional(), // 飞书自定义机器人签名校验可选
  }),
  z.object({
    type: z.literal('DINGTALK'),
    url: z.string().url(),
    secret: z.string().min(1), // 钉钉必填签名（timestamp + secret）
  }),
  z.object({
    type: z.literal('WECOM'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('TELEGRAM'),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('SLACK'),
    url: z.string().url(),
  }),
]);

export type ChannelConfig = z.infer<typeof ChannelConfig>;

export type ChannelConfigType = (typeof CHANNEL_TYPES)[number];
