import { Card } from '@/components/ui';
import { SettingsSectionHeader } from '../_components/settings-section-header';

export default function ProfileSettingsPage() {
  return (
    <>
      <SettingsSectionHeader
        title="账户"
        description="投资画像暂时保存在当前浏览器中，账户级同步将在后续版本开放。"
      />
      <Card>
        <div className="px-5 py-10 text-center">
          <h3 className="m-0 text-[15px] font-semibold">账户偏好即将开放</h3>
          <p className="mx-auto mt-2 max-w-[52ch] text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
            风险偏好、持仓周期与投资风格目前由分析页面中的本地选项管理。
          </p>
        </div>
      </Card>
    </>
  );
}
