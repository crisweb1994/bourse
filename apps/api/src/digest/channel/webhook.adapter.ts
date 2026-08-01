import { Injectable } from '@nestjs/common';
import type { BriefPayload } from '@bourse/analysis';
import { postJson } from '../../common/http';
import { ChannelAdapter } from './types';

/**
 * 通用 Webhook adapter（PRD DB.6）。
 *
 * 发送**完整 BriefPayload JSON**（不变式 #5：provenance/dataAsOf 透传，对接收方
 * 有用），带 HMAC-SHA256 签名头 `X-Bourse-Signature: sha256=<hex>`。接收方可据
 * 此验签。
 *
 * 不做 D13 截断——Webhook 接收的是结构化 JSON，由接收方自行渲染，无需平台截断。
 */
@Injectable()
export class WebhookAdapter implements ChannelAdapter {
  readonly type = 'WEBHOOK' as const;

  async send(
    payload: BriefPayload,
    channel: { type: 'WEBHOOK'; url: string; secret: string },
  ): Promise<{ httpStatus: number }> {
    return { httpStatus: await postJson(channel.url, payload, { hmacSecret: channel.secret }) };
  }
}
