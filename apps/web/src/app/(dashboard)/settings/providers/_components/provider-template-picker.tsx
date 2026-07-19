import Link from 'next/link';
import { ArrowRight, Wrench } from 'lucide-react';
import { Card } from '@/components/ui';
import { BUILTIN_PROVIDER_CATALOG } from '@/lib/ai-provider-catalog';
import { SettingsSectionHeader } from '../../_components/settings-section-header';

export function ProviderTemplatePicker() {
  return (
    <>
      <SettingsSectionHeader
        title="添加 Provider"
        description="选择模板预填 Endpoint 和常用模型，也可以从空白配置开始。"
      />
      <Card>
        <div className="border-b border-[var(--color-border-soft)] px-4 py-3 text-[12px] text-[var(--color-fg-2)]">
          Provider 模板
        </div>
        <div className="grid sm:grid-cols-2">
          {BUILTIN_PROVIDER_CATALOG.map((template) => (
            <Link
              key={template.id}
              href={`/settings/providers/new?template=${template.id}`}
              className="group flex min-h-[82px] items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-3 hover:bg-[var(--color-surface-hover)] sm:odd:border-r"
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] border border-black/10 text-[12px] font-bold text-white"
                style={{ background: template.iconColor || '#525252' }}
              >
                {template.iconText}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">
                  {template.label}
                </span>
                <span className="mt-1 block truncate font-mono text-[11px] text-[var(--color-fg-3)]">
                  {template.providerType === 'ANTHROPIC'
                    ? 'Anthropic 原生'
                    : 'OpenAI 兼容'}
                </span>
              </span>
              <ArrowRight
                className="h-4 w-4 text-[var(--color-fg-3)] transition-transform group-hover:translate-x-0.5"
                strokeWidth={1.5}
              />
            </Link>
          ))}
          <Link
            href="/settings/providers/new?template=custom"
            className="group flex min-h-[82px] items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-hover)]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] border border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <Wrench className="h-4 w-4 text-[var(--color-fg-2)]" strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold">自定义 Provider</span>
              <span className="mt-1 block text-[11px] text-[var(--color-fg-3)]">
                手动填写类型、Endpoint 和模型
              </span>
            </span>
            <ArrowRight
              className="h-4 w-4 text-[var(--color-fg-3)] transition-transform group-hover:translate-x-0.5"
              strokeWidth={1.5}
            />
          </Link>
        </div>
      </Card>
    </>
  );
}
