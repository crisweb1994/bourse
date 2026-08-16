/**
 * C14（visualization §5.2）— unicode sparkline：把 closes30d 渲染为单行
 * 块字符序列，Webhook JSON 接收方可直接打印。确定性纯函数。
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function unicodeSparkline(closes: number[]): string {
  const values = Array.isArray(closes) ? closes.filter((value) => Number.isFinite(value)) : [];
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - lo) / span) * BLOCKS.length))])
    .join('');
}

/** Inline SVG form for Webhook consumers that render HTML/CSS. Values are
 * numeric-only and the generated markup has no external references. */
export function inlineSparklineSvg(closes: number[]): string {
  const values = Array.isArray(closes) ? closes.filter((value) => Number.isFinite(value)) : [];
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((value, index) => {
      const x = (index * 96) / (values.length - 1);
      const y = 20 - ((value - lo) / span) * 16;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 24" width="96" height="24" role="img" aria-label="30日走势"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
