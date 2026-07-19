import { SettingsSectionHeader } from '../_components/settings-section-header';
import { WebSearchSettingsForm } from './web-search-form';

export default function WebSearchSettingsPage() {
  return (
    <>
      <SettingsSectionHeader
        title="联网搜索"
        description="配置分析流程使用的搜索适配器。模型原生搜索不可用时，可由 Tavily 或 SearXNG 提供外部证据。"
      />
      <WebSearchSettingsForm />
    </>
  );
}
