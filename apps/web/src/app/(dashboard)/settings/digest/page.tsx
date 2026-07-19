import { SettingsSectionHeader } from '../_components/settings-section-header';
import { DigestSettingsForm } from './digest-form';

export default function DigestSettingsPage() {
  return (
    <>
      <SettingsSectionHeader
        title="行情简报"
        description="选择关注市场、发送时点与投递渠道。简报只在订阅启用时生成。"
      />
      <DigestSettingsForm />
    </>
  );
}
