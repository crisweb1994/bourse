import { Injectable } from '@nestjs/common';
import type { BriefPayload } from '@bourse/analysis';
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
    const body = JSON.stringify(payload);
    const sig = await hmacSha256Hex(channel.secret, body);
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bourse-Signature': `sha256=${sig}`,
      },
      body,
    });
    return { httpStatus: res.status };
  }

}

/** Web Crypto HMAC-SHA256 → hex。Node 20 内置 globalThis.crypto.subtle。 */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Buffer.from(new Uint8Array(sig)).toString('hex');
}
