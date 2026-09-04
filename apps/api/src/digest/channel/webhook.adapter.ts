import { Injectable } from '@nestjs/common';
import { BriefPayload } from '../brief-payload';
import { postJson } from '../../common/http';
import { inlineSparklineSvg, unicodeSparkline } from './sparkline';
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
    // C14：为指数附上可直接打印的 unicode sparkline（接收方零渲染成本）。
    const enriched: BriefPayload = {
      ...payload,
      marketOverview: payload.marketOverview
        ? {
            ...payload.marketOverview,
            indices: payload.marketOverview.indices.map((index) =>
              index.closes30d
                ? {
                    ...index,
                    sparkline: unicodeSparkline(index.closes30d),
                    sparklineHtml: inlineSparklineSvg(index.closes30d),
                  }
                : index,
            ),
          }
        : payload.marketOverview,
      watchlist: {
        ...payload.watchlist,
        items: payload.watchlist.items.map((item) =>
          item.closes30d
            ? {
                ...item,
                sparkline: unicodeSparkline(item.closes30d),
                sparklineHtml: inlineSparklineSvg(item.closes30d),
              }
            : item,
        ),
      },
    };
    return { httpStatus: await postJson(channel.url, enriched, { hmacSecret: channel.secret }) };
  }
}
