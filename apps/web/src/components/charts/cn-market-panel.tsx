'use client';

/**
 * CN 专有面板（C10 北向资金流 + C11 解禁日历，visualization PRD §5.2）。
 * 数据来自 evidence 端点投影的 pack facts（northboundFlow / unlockCalendar），
 * 仅 CN 市场渲染；C11 空结果是合法信号（"未来无解禁 ✅"）。
 */

import type { NorthboundHoldingRow, NorthboundRow } from './primitives/northbound-chart';
import { NorthboundChart } from './primitives/northbound-chart';
import type { UnlockRow } from './primitives/unlock-timeline';
import { UnlockTimeline } from './primitives/unlock-timeline';
import { ChartFrame } from './chart-frame';

export function CnMarketPanel({
  market,
  northbound,
  northboundHoldings,
  unlockCalendar,
  northboundTier,
  unlockTier,
  degraded = false,
}: {
  market: string;
  northbound: unknown;
  northboundHoldings: unknown;
  unlockCalendar: unknown;
  /** 来源等级由 evidence provenance 提供（review P1-4e：不再硬编码 A）。 */
  northboundTier?: 'A' | 'B' | 'C' | 'D' | 'E';
  unlockTier?: 'A' | 'B' | 'C' | 'D' | 'E';
  degraded?: boolean;
}) {
  if (market !== 'CN') return null;
  const nbRows = Array.isArray(northbound) ? (northbound as NorthboundRow[]) : [];
  const holdingRows = Array.isArray(northboundHoldings)
    ? (northboundHoldings as NorthboundHoldingRow[])
    : [];
  const unlockMissing = unlockCalendar == null;
  const ulRows = Array.isArray(unlockCalendar) ? (unlockCalendar as UnlockRow[]) : [];
  const northboundAsOf = latestDate([...nbRows, ...holdingRows]);
  const unlockAsOf = latestDate(ulRows);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame
        title="北向资金"
        status={nbRows.length > 0 || holdingRows.length > 0 ? 'ready' : 'empty'}
        asOf={northboundAsOf}
        sourceTier={northboundTier}
        degradedNote={degraded ? '数据降级：北向资金图表基于部分来源生成' : undefined}
        emptyReason={{ message: '暂无可验证的北向净流入或持股披露' }}
        ariaSummary={nbRows.length > 0 ? `近 ${nbRows.length} 日北向资金净流入` : `最近 ${holdingRows.length} 条北向持股披露`}
      >
        <NorthboundChart rows={nbRows} holdings={holdingRows} />
      </ChartFrame>
      {!unlockMissing && ulRows.length > 0 ? (
        <ChartFrame
          title="解禁日历"
          status="ready"
          asOf={unlockAsOf}
          sourceTier={unlockTier}
          degradedNote={degraded ? '数据降级：解禁日历基于部分来源生成' : undefined}
          ariaSummary={`未来 ${ulRows.length} 次解禁`}
        >
          <UnlockTimeline rows={ulRows} />
        </ChartFrame>
      ) : (
        <ChartFrame
          title="解禁日历"
          status="empty"
          sourceTier={unlockTier}
          emptyReason={{ message: unlockMissing ? '解禁数据未由当前来源提供' : '未来 90 天无解禁安排（空结果本身是信号）' }}
        />
      )}
    </div>
  );
}

function latestDate(rows: Array<{ date?: string }>): string | null {
  const dates = rows.map((row) => row.date).filter((date): date is string => typeof date === 'string' && date.length > 0).sort();
  return dates.at(-1) ?? null;
}
