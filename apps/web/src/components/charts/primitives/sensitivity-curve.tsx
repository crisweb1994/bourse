'use client';

/**
 * C9 · 反向 DCF 敏感度曲线（visualization PRD §5.2）。
 * 公允价值随假设增长率的确定性扫描曲线 + 现价水平线；交点即
 * impliedGrowthRate（现价隐含增长率）。V6：回答"当前价已经隐含了什么
 * 预期"，不做任何价格预测。
 */

const W = 460;
const H = 200;
const PL = 8;
const PR = 46;
const PT = 14;
const PB = 26;

export interface SensitivityPoint {
  growth: number;
  fairValuePerShare: number;
}

export function SensitivityCurve({
  points,
  currentPrice,
  impliedGrowth,
  currency,
}: {
  points: SensitivityPoint[];
  currentPrice: number | null;
  impliedGrowth: number | null;
  currency?: string | null;
}) {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.growth);
  const ys = points.map((p) => p.fairValuePerShare);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys) * 0.9;
  const yMax = Math.max(...ys) * 1.06;

  const x = (g: number) => PL + ((g - xMin) / (xMax - xMin || 1)) * (W - PL - PR);
  const y = (v: number) => PT + ((yMax - v) / (yMax - yMin || 1)) * (H - PT - PB);

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.growth).toFixed(1)},${y(p.fairValuePerShare).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="反向 DCF 敏感度：公允价值随假设增长率变化曲线">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={PL} x2={W - PR} y1={PT + f * (H - PT - PB)} y2={PT + f * (H - PT - PB)} stroke="var(--color-border)" strokeWidth={0.6} />
      ))}

      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1.8} />

      {currentPrice !== null && currentPrice > 0 ? (
        <>
          <line x1={PL} x2={W - PR} y1={y(currentPrice)} y2={y(currentPrice)} stroke="var(--color-warn)" strokeWidth={1.4} strokeDasharray="6 4" />
          <rect x={W - PR + 2} y={y(currentPrice) - 9} width={44} height={18} rx={4} fill="var(--color-warn)" />
          <text x={W - PR + 24} y={y(currentPrice) + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">
            {currentPrice.toFixed(0)}
          </text>
          {impliedGrowth !== null && impliedGrowth >= xMin && impliedGrowth <= xMax ? (
            <>
              <circle cx={x(impliedGrowth)} cy={y(currentPrice)} r={5} fill="var(--color-elev)" stroke="var(--color-warn)" strokeWidth={2} />
              <text
                x={x(impliedGrowth)}
                y={Math.max(y(currentPrice) + 20, PT + 10)}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill="var(--color-warn)"
              >
                隐含 {(impliedGrowth * 100).toFixed(1)}%
              </text>
            </>
          ) : null}
        </>
      ) : null}

      {points
        .filter((_, i) => i % 4 === 0 || i === points.length - 1)
        .map((p) => (
          <text key={p.growth} x={x(p.growth)} y={H - 8} textAnchor="middle" fontSize={9.5} fill="var(--color-fg-3)">
            {(p.growth * 100).toFixed(0)}%
          </text>
        ))}
      <text x={PL + 2} y={H - 8} fontSize={9.5} fill="var(--color-fg-3)">
        假设增长率 →
      </text>
      <text x={W - 2} y={PT + 8} textAnchor="end" fontSize={9.5} fill="var(--color-fg-3)">
        公允价值/股{currency ? `（${currency}）` : ''}
      </text>
    </svg>
  );
}
