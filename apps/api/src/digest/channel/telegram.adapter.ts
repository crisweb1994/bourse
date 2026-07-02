import { Injectable } from '@nestjs/common';
import type { BriefPayload } from '@bourse/analysis';
import { ChannelAdapter } from './types';
import { renderMarkdown } from './render';
import { reanalyzeUrl } from './button-url';

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
    // Telegram legacy Markdown 模式对 _ * [ ] 要求严格配对，AI 中文解读极易触发
    // 400。TG 无色，markdown 价值有限 → 直接发纯文本（剥掉 * 加粗符），靠 emoji
    // 区分段落。比 MarkdownV2 全量转义更稳，也省一次格式转换。
    const text = renderMarkdown(payload).replace(/\*/g, '');
    const url = `https://api.telegram.org/bot${channel.botToken}/sendMessage`;
    const reanalyze = payload.watchlist.reanalyzeHints[0];
    const body: Record<string, unknown> = {
      chat_id: channel.chatId,
      text,
      // 不设 parse_mode → 纯文本，Telegram 不解析任何特殊字符。
    };
    if (reanalyze) {
      const btnUrl = reanalyzeUrl(reanalyze.symbol);
      if (btnUrl) {
        // 生产（公网域名）才带按钮；dev/未配 FRONTEND_URL 时 reanalyzeUrl 返回
        // null，Telegram 拒绝 localhost URL，跳过按钮避免 400。
        body.reply_markup = {
          inline_keyboard: [
            [{ text: `复研 ${reanalyze.symbol}`, url: btnUrl }],
          ],
        };
      }
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { httpStatus: res.status };
  }
}
