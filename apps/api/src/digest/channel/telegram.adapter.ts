import { Injectable } from '@nestjs/common';
import type { BriefPayload } from '@bourse/analysis';
import { ChannelAdapter } from './types';
import { renderMarkdown } from './render';

/**
 * Telegram adapter（PRD DB.6）。
 *
 * 发 markdown（无色，用 emoji）+ inline keyboard 按钮（跳转 URL，单向无回调）。
 * 用 Bot Token 调 `sendMessage`。D13 截断由 renderMarkdown 统一做。
 */
@Injectable()
export class TelegramAdapter implements ChannelAdapter {
  readonly type = 'TELEGRAM' as const;

  async send(
    payload: BriefPayload,
    channel: { type: 'TELEGRAM'; botToken: string; chatId: string },
  ): Promise<{ httpStatus: number }> {
    const text = renderMarkdown(payload);
    const url = `https://api.telegram.org/bot${channel.botToken}/sendMessage`;
    const reanalyze = payload.watchlist.reanalyzeHints[0];
    const body: Record<string, unknown> = {
      chat_id: channel.chatId,
      text,
      parse_mode: 'Markdown',
    };
    if (reanalyze) {
      body.reply_markup = {
        inline_keyboard: [
          [
            {
              text: `复研 ${reanalyze.symbol}`,
              url: `/stock/${reanalyze.symbol}?reanalyze=1`,
            },
          ],
        ],
      };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { httpStatus: res.status };
  }
}
