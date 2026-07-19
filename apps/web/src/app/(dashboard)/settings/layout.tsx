import { PageHeader } from '@/components/ui';
import { SettingsNav } from './_components/settings-nav';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <PageHeader
        tag="账户 · 设置"
        title="设置"
        subtitle="管理 AI 服务、联网数据与自动投递。每个设置域独立保存，互不阻塞。"
        className="mb-8"
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-10">
        <aside className="min-w-0 lg:sticky lg:top-8 lg:self-start">
          <SettingsNav />
        </aside>
        <section className="min-w-0">{children}</section>
      </div>
    </div>
  );
}
