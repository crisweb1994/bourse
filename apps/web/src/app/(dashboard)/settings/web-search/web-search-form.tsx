'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Plug,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  Button,
  Card,
  Pill,
  SectionTag,
  SwitchRow,
  toast,
  useConfirm,
} from '@/components/ui';
import {
  deleteWebSearchSetting,
  getWebSearchSetting,
  putWebSearchSetting,
  testWebSearchSetting,
  type WebSearchPrimaryMode,
  type WebSearchProviderType,
  type WebSearchSettingDto,
  type WebSearchTestResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/** Per-user web search adapter config. One saved adapter can override deployment defaults. */
interface AdapterMeta {
  id: WebSearchProviderType | 'NONE';
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
  /** Used for the left-column dot color. */
  enabled: boolean;
  needsBaseUrl: boolean;
  needsApiKey: boolean;
}

const ADAPTERS: AdapterMeta[] = [
  {
    id: 'NONE',
    name: '禁用',
    description: '用 env / native',
    status: 'available',
    enabled: false,
    needsBaseUrl: false,
    needsApiKey: false,
  },
  {
    id: 'TAVILY',
    name: 'Tavily',
    description: '专为 LLM 优化的 search API',
    status: 'available',
    enabled: false,
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    id: 'SEARXNG',
    name: 'SearXNG',
    description: '开源 metasearch, 自部署',
    status: 'available',
    enabled: false,
    needsBaseUrl: true,
    needsApiKey: false,
  },
];

const COMING_SOON: AdapterMeta[] = [
  {
    id: 'NONE',
    name: 'Serper',
    description: 'Coming soon',
    status: 'coming-soon',
    enabled: false,
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    id: 'NONE',
    name: 'Brave Search',
    description: 'Coming soon',
    status: 'coming-soon',
    enabled: false,
    needsBaseUrl: false,
    needsApiKey: true,
  },
  {
    id: 'NONE',
    name: 'Google PSE',
    description: 'Coming soon',
    status: 'coming-soon',
    enabled: false,
    needsBaseUrl: false,
    needsApiKey: true,
  },
];

type FormState = {
  providerType: WebSearchProviderType | 'NONE';
  apiKey: string;
  baseUrl: string;
  primaryMode: WebSearchPrimaryMode;
};

const EMPTY_FORM: FormState = {
  providerType: 'NONE',
  apiKey: '',
  baseUrl: '',
  primaryMode: 'NATIVE_FIRST',
};

function fromDto(dto: WebSearchSettingDto): FormState {
  return {
    providerType: dto.providerType,
    apiKey: '',
    baseUrl: dto.baseUrl ?? '',
    primaryMode: dto.primaryMode,
  };
}

export function WebSearchSettingsForm() {
  const confirm = useConfirm();
  const [data, setData] = useState<WebSearchSettingDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getWebSearchSetting()
      .then((row) => {
        if (cancelled) return;
        setData(row);
        setForm(row ? fromDto(row) : EMPTY_FORM);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAdapter =
    ADAPTERS.find((a) => a.id === form.providerType) ?? ADAPTERS[0];

  const canSave = useMemo(() => {
    if (saving) return false;
    if (form.providerType === 'NONE') return data !== null; // need to delete
    if (form.providerType === 'TAVILY') {
      // need a key — either freshly typed or existing on the row (we don't
      // ship the real key back to the client, only a mask; an empty apiKey
      // input means "keep existing" only when there's already a row of the
      // same providerType in `data`)
      const keptKey =
        data?.providerType === 'TAVILY' && (data.apiKeyMasked ?? '').length > 0;
      return form.apiKey.trim().length > 0 || keptKey;
    }
    if (form.providerType === 'SEARXNG') return form.baseUrl.trim().length > 0;
    return false;
  }, [form, data, saving]);

  const updateForm = (patch: Partial<FormState>): void => {
    setForm((s) => ({ ...s, ...patch }));
    setTestResult(null);
  };

  const selectAdapter = (id: WebSearchProviderType | 'NONE'): void => {
    // Switching adapter wipes the form to defaults for the new provider.
    if (id === form.providerType) return;
    setForm({
      providerType: id,
      apiKey: '',
      baseUrl: id === 'SEARXNG' && data?.providerType === 'SEARXNG' ? data.baseUrl ?? '' : '',
      primaryMode: form.primaryMode,
    });
    setTestResult(null);
  };

  const payload = () => ({
    providerType: form.providerType as WebSearchProviderType,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    primaryMode: form.primaryMode,
  });

  const handleTest = async (): Promise<void> => {
    if (form.providerType === 'NONE') return;
    setTesting(true);
    try {
      const r = await testWebSearchSetting(payload());
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (form.providerType === 'NONE') {
        await deleteWebSearchSetting();
        setData(null);
        setForm(EMPTY_FORM);
        toast.success('已清除联网搜索配置');
        return;
      }
      const row = await putWebSearchSetting(payload());
      setData(row);
      setForm(fromDto(row));
      toast.success('联网搜索配置已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!data) return;
    const ok = await confirm({
      title: '删除联网搜索配置？',
      description: '删除后将恢复使用部署环境或模型原生搜索。',
      confirmText: '删除配置',
      cancelText: '保留配置',
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteWebSearchSetting();
      setData(null);
      setForm(EMPTY_FORM);
      setTestResult(null);
      toast.success('已删除');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="px-5 py-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <SectionTag>搜索适配器</SectionTag>
        <Pill variant={data ? 'emerald' : 'neutral'}>{data ? '已配置' : '默认策略'}</Pill>
      </div>

      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* ============ Left: adapter list ============ */}
        <div className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg-elev)] py-3 lg:border-b-0 lg:border-r">
          <p className="px-4 pb-3 text-[11px] leading-[1.55] text-[var(--color-fg-3)] border-b border-[var(--color-border-soft)]">
            同时仅一个 adapter 生效。切换会覆盖当前配置。
          </p>
          <div className="grid gap-1 pt-2 sm:grid-cols-2 lg:block">
            {ADAPTERS.map((a) => {
              const active = form.providerType === a.id;
              const isEnabled = data?.providerType === a.id || (a.id === 'NONE' && !data);
              return (
                <AdapterRow
                  key={a.name}
                  meta={a}
                  active={active}
                  enabled={isEnabled}
                  onClick={() => selectAdapter(a.id)}
                />
              );
            })}
            {COMING_SOON.map((a) => (
              <AdapterRow key={a.name} meta={a} active={false} enabled={false} disabled />
            ))}
          </div>
        </div>

        {/* ============ Right: config panel ============ */}
        <div className="min-w-0 space-y-4 p-4 sm:p-5">
          {loading ? (
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-fg-2)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
              加载中…
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[15px] font-semibold">{selectedAdapter.name}</div>
                  <div className="mt-1 text-[12px] text-[var(--color-fg-2)] max-w-[460px] leading-[1.55]">
                    {selectedAdapter.id === 'NONE'
                      ? '不覆盖部署侧 env 配置；继续使用 provider native（Claude/OpenAI Responses）或全局 TAVILY_API_KEY/SEARXNG_BASE_URL。'
                      : selectedAdapter.description}
                  </div>
                </div>
                {data?.providerType === selectedAdapter.id && (
                  <Pill variant="emerald">已启用</Pill>
                )}
              </div>

              {/* Provider-specific config fields */}
              {selectedAdapter.needsApiKey && (
                <Field
                  label="API Key"
                  hint={
                    data?.providerType === selectedAdapter.id && data.apiKeyMasked
                      ? `当前：${data.apiKeyMasked} · 留空保持不变`
                      : '从 provider 控制台复制；明文存储，仅你本人可见'
                  }
                >
                  <input
                    type="password"
                    aria-label="搜索适配器 API Key"
                    value={form.apiKey}
                    onChange={(e) => updateForm({ apiKey: e.target.value })}
                    placeholder={
                      selectedAdapter.id === 'TAVILY' ? 'tvly-XXXXXXXXXXXXXXXX' : ''
                    }
                    className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] font-mono text-[12.5px] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </Field>
              )}

              {selectedAdapter.needsBaseUrl && (
                <Field label="Base URL" hint="你的 SearXNG 实例 URL，e.g. https://searxng.example.com">
                  <input
                    type="text"
                    aria-label="SearXNG Base URL"
                    value={form.baseUrl}
                    onChange={(e) => updateForm({ baseUrl: e.target.value })}
                    placeholder="https://searxng.example.com"
                    className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] font-mono text-[12.5px] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </Field>
              )}

              {selectedAdapter.id !== 'NONE' && (
                <div>
                  <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-2)]">
                    主从策略
                  </div>
                  <div className="space-y-1.5">
                    <SwitchRow
                      label="AI 自带 web_search 优先（推荐）"
                      desc="Claude / OpenAI Responses API 走 native；自定义 adapter 仅在 native 不可用时启用。"
                      checked={form.primaryMode === 'NATIVE_FIRST'}
                      onCheckedChange={(v: boolean) =>
                        updateForm({ primaryMode: v ? 'NATIVE_FIRST' : 'CUSTOM_ONLY' })
                      }
                    />
                    <SwitchRow
                      label="总是用我配置的 adapter"
                      desc="OpenAI 兼容 Provider 强制使用此 adapter；Anthropic 受 SDK 限制，运行时仍使用原生搜索。"
                      checked={form.primaryMode === 'CUSTOM_ONLY'}
                      onCheckedChange={(v: boolean) =>
                        updateForm({ primaryMode: v ? 'CUSTOM_ONLY' : 'NATIVE_FIRST' })
                      }
                    />
                  </div>
                </div>
              )}

              {testResult && (
                <div
                  className={cn(
                    'flex items-start gap-2 px-3 py-2 rounded-md font-mono text-[11.5px] border',
                    testResult.ok
                      ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent-line)] text-[var(--color-accent)]'
                      : 'bg-[var(--color-danger-soft)] border-[var(--color-danger-line)] text-[var(--color-danger)]',
                  )}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5" strokeWidth={1.5} />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 mt-0.5" strokeWidth={1.5} />
                  )}
                  <div className="flex-1 min-w-0">
                    {testResult.ok ? (
                      <>
                        连接 OK · {testResult.latencyMs}ms
                        {testResult.sample && (
                          <>
                            {' · '}
                            首条：<span className="opacity-80">{testResult.sample.title}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <>失败 · {testResult.error || '未知错误'}</>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                {selectedAdapter.id !== 'NONE' ? (
                  <Button onClick={handleTest} disabled={testing}>
                    {testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                    ) : (
                      <Zap className="w-3 h-3" strokeWidth={1.5} />
                    )}
                    测试连接
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  {data && form.providerType === data.providerType && (
                    <Button variant="quiet" onClick={handleDelete} disabled={saving}>
                      <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                      删除
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={!canSave}
                  >
                    {saving ? (
                      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                    ) : (
                      <Plug className="w-3 h-3" strokeWidth={1.5} />
                    )}
                    {form.providerType === 'NONE' ? '清除并保存' : '保存'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function AdapterRow({
  meta,
  active,
  enabled,
  disabled,
  onClick,
}: {
  meta: AdapterMeta;
  active: boolean;
  enabled: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'mx-2 flex min-h-12 w-[calc(100%_-_16px)] items-center justify-between rounded-[6px] border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-[var(--color-border)] bg-[var(--color-bg-elev)]'
          : 'border-transparent hover:bg-[var(--color-surface-hover)]',
        disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent',
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{meta.name}</div>
        <div className="text-[11px] text-[var(--color-fg-3)] mt-0.5">
          {meta.description}
        </div>
      </div>
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full shrink-0',
          enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-fg-4)]',
        )}
      />
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-2)]">
        {label}
      </div>
      {children}
      {hint && (
        <p className="mt-1 m-0 text-[11px] text-[var(--color-fg-3)] leading-[1.5]">
          {hint}
        </p>
      )}
    </div>
  );
}
