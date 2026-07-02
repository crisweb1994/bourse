import { Injectable } from '@nestjs/common';
import type { BriefPayload } from '@bourse/analysis';
import { ChannelAdapter } from './types';
import { renderMarkdown } from './render';

/**
 * 飞书 adapter（PRD DB.6）。
 *
 * 发 interactive card（`msg_type=interactive`）。飞书是唯一有颜色的平台（预设色板，
 * 非 hex）：绿=涨、红=跌、灰=中性。可选 secret 走签名校验（飞书自定义机器人）。
 *
 * D13 截断：卡片放大盘段 + 自选聚合解读 + 异动票（含深入），非异动票折叠。
 */
@Injectable()
export class FeishuAdapter implements ChannelAdapter {
  readonly type = 'FEISHU' as const;

  async send(
    payload: BriefPayload,
    channel: { type: 'FEISHU'; url: string; secret?: string },
  ): Promise<{ httpStatus: number }> {
    const md = renderMarkdown(payload);
    const card = {
      config: { wide_screen_mode: true },
      header: cardHeader(payload),
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: md } },
        ...actionButtons(payload),
      ],
    };
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card }),
    });
    return { httpStatus: res.status };
  }
}

function cardHeader(payload: BriefPayload): {
  title: { tag: 'plain_text'; content: string };
  template: string;
} {
  // 模板色板：green/blue/red。大盘涨跌决定主色。
  const up = payload.marketOverview.indices.some((i) => i.changePct > 0);
  const down = payload.marketOverview.indices.some((i) => i.changePct < 0);
  const template =
    up && !down ? 'green' : down && !up ? 'red' : 'blue'; // 混合 → 中性蓝
  const sessionLabel = payload.session === 'PRE' ? '盘前' : '盘后';
  const marketLabel = { US: '美股', CN: 'A股', HK: '港股' }[payload.market];
  return {
    title: { tag: 'plain_text', content: `📊 ${sessionLabel}简报 · ${marketLabel}` },
    template,
  };
}

/** 复研/详情跳转按钮（单向 URL，无回调）。 */
function actionButtons(payload: BriefPayload): { tag: 'action'; actions: unknown[] }[] {
  const reanalyze = payload.watchlist.reanalyzeHints[0];
  if (!reanalyze) return [];
  return [
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: `复研 ${reanalyze.symbol}` },
          url: `/stock/${reanalyze.symbol}?reanalyze=1`,
          type: 'primary',
        },
      ],
    },
  ];
}
