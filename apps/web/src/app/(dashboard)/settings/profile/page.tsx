'use client';

/**
 * plan-v2 Wave 4.2 — InvestorProfile persistence removed. plan-v2 §15.1
 * decision: user preferences live in URL params + localStorage in beta;
 * the full settings page returns in v1.x.
 */
export default function ProfileSettingsPage() {
  return (
    <div className="max-w-2xl">
      <h2 className="mb-3 text-lg font-medium">投资画像</h2>
      <p className="text-[13px] text-[var(--color-fg-2)]">
        投资偏好暂未做持久化。后续会换成一个轻量的本地偏好编辑器
        （风险偏好 / 持仓周期 / 风格），用 localStorage 保存。
      </p>
    </div>
  );
}
