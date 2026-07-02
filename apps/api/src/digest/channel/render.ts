import type { BriefPayload } from '@bourse/analysis';

/**
 * BriefPayload → 人类可读 markdown（PRD DB.6 / §0.5 卡片样例）。
 *
 * D13 截断（异动 + 大盘优先）：
 *   - 大盘段：永远放
 *   - 自选聚合解读：永远放
 *   - 异动票（有 deepDive 的）：放，含深入
 *   - 非异动票：折叠（不逐条展开，聚合解读已点名全部概况）
 *
 * 无色平台（TG/钉钉/企微）用 emoji：`↑🟢`/`↓🔴`/`⚠️财报`（PRD DB.6）。
 * 数字全来自 BriefPayload（已由 compute 产出），此处只渲染，守不变式 #1。
 */
export function renderMarkdown(p: BriefPayload): string {
  return [marketOverviewMd(p), watchlistMd(p)].filter(Boolean).join('\n\n');
}

function marketOverviewMd(p: BriefPayload): string {
  if (p.marketOverview.indices.length === 0) return '';
  const lines = p.marketOverview.indices.map(
    (i) => `${arrow(i.changePct)} *${i.name}* ${pct(i.changePct)}`,
  );
  let md = '📈 *大盘*\n' + lines.join('\n');
  if (p.marketOverview.interpretation) {
    md += `\n💬 ${p.marketOverview.interpretation}`;
  }
  return md;
}

function watchlistMd(p: BriefPayload): string {
  const w = p.watchlist;
  if (w.items.length === 0) return '';

  // 异动票 = 有 deepDive 的票（命中触发才有）。非异动折叠。
  const anomalies = w.items.filter((i) => i.deepDive);
  let md = '⭐ *你的自选*';
  // 自选聚合解读永远放（点名全部概况，符合 D13）。
  if (w.interpretation) md += `\n💬 ${w.interpretation}`;

  for (const i of anomalies) {
    md += `\n🔍 *${i.symbol}* 异动深入\n${i.deepDive}`;
  }
  return md;
}

function arrow(v: number): string {
  if (v > 0) return '↑🟢';
  if (v < 0) return '↓🔴';
  return '→⚪';
}

function pct(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}
