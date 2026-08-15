'use client';

/**
 * CN 专有面板（C10 北向资金流 + C11 解禁日历，visualization PRD §5.2）。
 * 数据来自 evidence 端点投影的 pack facts（northboundFlow / unlockCalendar），
 * 仅 CN 市场渲染；C11 空结果是合法信号（"未来无解禁 ✅"）。
 */

import type { NorthboundRow } from './primitives/northbound-chart';
import { NorthboundChart } from './primitives/northbound-chart';
import type { UnlockRow } from './primitives/unlock-timeline';
import { UnlockTimeline } from './primitives/unlock-timeline';
import { ChartFrame } from './chart-frame';

export function CnMarketPanel({
  market,
  northbound,
  unlockCalendar,
}: {
  market: string;
  northbound: unknown;
  unlockCalendar: unknown;
}) {
  if (market !== 'CN') return null;
  const nbRows = Array.isArray(northbound) ? (northbound as NorthboundRow[]) : [];
  const ulRows = Array.isArray(unlockCalendar) ? (unlockCalendar as UnlockRow[]) : [];

  if (nbRows.length === 0 && ulRows.length === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {nbRows.length > 0 ? (
        <ChartFrame
          title="北向资金"
          status="ready"
          sourceTier="A"
          ariaSummary={`近 ${nbRows.length} 日北向资金净流入与最新持股占比`}
        >
          <NorthboundChart rows={nbRows} />
        </ChartFrame>
      ) : null}
      {ulRows.length > 0 ? (
        <ChartFrame
          title="解禁日历"
          status="ready"
          sourceTier="A"
          ariaSummary={`未来 ${ulRows.length} 次解禁`}
        >
          <UnlockTimeline rows={ulRows} />
        </ChartFrame>
      ) : (
        <ChartFrame
          title="解禁日历"
          status="empty"
          sourceTier="A"
          emptyReason={{ message: '未来 90 天无解禁安排 ✅（成熟股票常见，空结果本身是信号）' }}
        />
      )}
    </div>
  );
}
