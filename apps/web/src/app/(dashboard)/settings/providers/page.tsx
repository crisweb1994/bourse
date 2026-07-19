'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronRight, Cpu, Loader2, Plus, RefreshCw, Star } from 'lucide-react';
import { Card, Pill } from '@/components/ui';
import { listAiProviderSettings, type AiProviderSettingDto } from '@/lib/api';
import { SettingsSectionHeader } from '../_components/settings-section-header';

export default function ProviderSettingsPage() {
  const [providers, setProviders] = useState<AiProviderSettingDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    listAiProviderSettings()
      .then(setProviders)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : '无法加载 Provider'),
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <>
      <SettingsSectionHeader
        title="AI Provider"
        description="每个 Provider 独立管理连接凭证、启用模型和运行能力。分析页面只会显示已启用的配置。"
        actions={
          <Link
            href="/settings/providers/new"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-fg)] bg-[var(--color-fg)] px-3.5 text-[13px] font-medium leading-none text-[var(--color-bg)] hover:bg-[#1f1f1f]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
            添加 Provider
          </Link>
        }
      />

      {loading ? (
        <ProviderListSkeleton />
      ) : error ? (
        <Card>
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <p className="m-0 text-[13px] text-[var(--color-danger)]">{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-surface-hover)]"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
              重新加载
            </button>
          </div>
        </Card>
      ) : providers.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-2)]">
              <Cpu className="h-5 w-5 text-[var(--color-fg-2)]" strokeWidth={1.5} />
            </div>
            <h3 className="mb-0 mt-4 text-[15px] font-semibold">还没有 AI Provider</h3>
            <p className="mb-0 mt-2 max-w-[48ch] text-[13px] leading-[1.6] text-[var(--color-fg-2)]">
              从内置模板开始，配置一个可用于股票分析的模型服务。
            </p>
            <Link
              href="/settings/providers/new"
              className="mt-5 inline-flex h-9 items-center gap-2 rounded-[var(--radius-btn)] bg-[var(--color-fg)] px-3.5 text-[13px] font-medium text-[var(--color-bg)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
              添加第一个 Provider
            </Link>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="border-b border-[var(--color-border-soft)] px-4 py-3 text-[12px] text-[var(--color-fg-2)]">
            已配置 {providers.length} 个 Provider
          </div>
          <div>
            {providers.map((provider) => (
              <Link
                key={provider.id}
                href={`/settings/providers/${provider.id}`}
                className="group grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0 hover:bg-[var(--color-surface-hover)] sm:grid-cols-[minmax(180px,1.2fr)_minmax(180px,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        provider.enabled
                          ? 'bg-[var(--color-accent)]'
                          : 'bg-[var(--color-fg-4)]'
                      }`}
                      aria-hidden
                    />
                    <span className="truncate text-[14px] font-semibold">
                      {provider.label}
                    </span>
                    {provider.isDefault && (
                      <Star
                        className="h-3.5 w-3.5 shrink-0 fill-[var(--color-accent)] text-[var(--color-accent)]"
                        strokeWidth={1.5}
                        aria-label="默认 Provider"
                      />
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 pl-4">
                    <Pill variant={provider.enabled ? 'emerald' : 'neutral'} dot>
                      {provider.enabled ? '已启用' : '已停用'}
                    </Pill>
                    <span className="font-mono text-[11px] text-[var(--color-fg-3)]">
                      {provider.providerType === 'ANTHROPIC'
                        ? 'Anthropic 原生'
                        : 'OpenAI 兼容'}
                    </span>
                  </div>
                </div>

                <div className="hidden min-w-0 sm:block">
                  <div className="truncate font-mono text-[12px] text-[var(--color-fg)]">
                    {provider.primaryModel || provider.enabledModels[0] || '未设置主模型'}
                  </div>
                  <div className="mt-1 truncate text-[11.5px] text-[var(--color-fg-3)]">
                    {provider.utilityModel
                      ? `Utility · ${provider.utilityModel}`
                      : `${provider.enabledModels.length} 个启用模型`}
                  </div>
                </div>

                <ChevronRight
                  className="h-4 w-4 text-[var(--color-fg-3)] transition-transform group-hover:translate-x-0.5"
                  strokeWidth={1.5}
                />
              </Link>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function ProviderListSkeleton() {
  return (
    <Card aria-label="正在加载 Provider">
      <div className="flex items-center justify-center gap-2 px-5 py-16 text-[13px] text-[var(--color-fg-2)]">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
        正在加载 Provider...
      </div>
    </Card>
  );
}
