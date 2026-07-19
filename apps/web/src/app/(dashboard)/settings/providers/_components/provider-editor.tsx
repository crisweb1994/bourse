'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  Button,
  Card,
  Input,
  InputShell,
  Select,
  SelectOption,
  SwitchRow,
  toast,
  useConfirm,
} from '@/components/ui';
import {
  createAiProviderSetting,
  deleteAiProviderSetting,
  fetchProviderModels,
  getAiProviderSetting,
  testProviderConnection,
  updateAiProviderSetting,
  type AiModelOptionDto,
  type AiProviderSettingDetailDto,
  type AiProviderSettingInput,
  type ProviderTypeStr,
} from '@/lib/api';
import { BUILTIN_PROVIDER_CATALOG } from '@/lib/ai-provider-catalog';
import { cn } from '@/lib/utils';
import { SettingsSectionHeader } from '../../_components/settings-section-header';
import { ModelPicker } from './model-picker';

interface FormState {
  label: string;
  providerType: ProviderTypeStr;
  baseUrl: string;
  apiKey: string;
  enabledModels: string[];
  primaryModel: string;
  utilityModel: string;
  isDefault: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  label: '',
  providerType: 'OPENAI_COMPATIBLE',
  baseUrl: '',
  apiKey: '',
  enabledModels: [],
  primaryModel: '',
  utilityModel: '',
  isDefault: false,
  enabled: true,
};

export function ProviderEditor({
  providerId,
  templateId,
}: {
  providerId?: string;
  templateId?: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const isNew = !providerId;
  const [form, setForm] = useState<FormState>(() => formFromTemplate(templateId));
  const [initialSnapshot, setInitialSnapshot] = useState(() =>
    providerId ? snapshot(formFromTemplate(templateId), false) : '__new__',
  );
  const [hasApiKey, setHasApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<AiModelOptionDto[]>([]);
  const [modelInput, setModelInput] = useState('');
  const [loading, setLoading] = useState(Boolean(providerId));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setLoading(true);
    getAiProviderSetting(providerId)
      .then((detail) => {
        if (cancelled) return;
        const next = formFromDetail(detail);
        setForm(next);
        setHasApiKey(detail.hasApiKey);
        setInitialSnapshot(snapshot(next, false));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : '无法加载 Provider');
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const isDirty = snapshot(form, clearApiKey) !== initialSnapshot;

  useEffect(() => {
    if (isDirty) document.documentElement.dataset.settingsDirty = 'true';
    else delete document.documentElement.dataset.settingsDirty;
    return () => {
      delete document.documentElement.dataset.settingsDirty;
    };
  }, [isDirty]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const effectivePrimary = form.primaryModel || form.enabledModels[0] || '';
  const canTest = Boolean(
    effectivePrimary && (form.apiKey.trim() || (hasApiKey && !clearApiKey)),
  );

  const updateForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTestResult(null);
  };

  const save = async () => {
    const error = validate(form);
    if (error) {
      toast.error(error);
      return;
    }
    setSaving(true);
    try {
      const payload: AiProviderSettingInput = {
        label: form.label.trim(),
        providerType: form.providerType,
        baseUrl: form.baseUrl.trim(),
        enabledModels: form.enabledModels,
        primaryModel: effectivePrimary,
        utilityModel: form.utilityModel.trim(),
        isDefault: form.isDefault,
        enabled: form.enabled,
      };
      if (isNew || form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
      if (!isNew && clearApiKey) payload.clearApiKey = true;

      const saved = providerId
        ? await updateAiProviderSetting(providerId, payload)
        : await createAiProviderSetting(payload);
      const next = formFromDetail(saved);
      setForm(next);
      setHasApiKey(saved.hasApiKey);
      setClearApiKey(false);
      setInitialSnapshot(snapshot(next, false));
      delete document.documentElement.dataset.settingsDirty;
      toast.success(isNew ? 'Provider 已创建' : 'Provider 设置已保存');
      if (isNew) router.replace(`/settings/providers/${saved.id}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存 Provider 失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!providerId) return;
    const ok = await confirm({
      title: `删除“${form.label}”？`,
      description: '该 Provider 会被永久删除。依赖它的新分析将回退到其他默认配置。',
      confirmText: '删除 Provider',
      cancelText: '保留 Provider',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAiProviderSetting(providerId);
      delete document.documentElement.dataset.settingsDirty;
      toast.success('Provider 已删除');
      router.replace('/settings/providers');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '删除 Provider 失败');
    }
  };

  const loadModels = async () => {
    if (form.providerType === 'OPENAI_COMPATIBLE' && !form.baseUrl.trim()) {
      toast.error('请先填写 Base URL');
      return;
    }
    if (!isNew && clearApiKey && !form.apiKey.trim()) {
      toast.error('密钥已标记为清除，请先输入替换密钥');
      return;
    }
    setLoadingModels(true);
    try {
      const list = await fetchProviderModels(
        {
          providerType: form.providerType,
          baseUrl: form.baseUrl.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        },
        providerId,
      );
      setModels(list);
      toast.success(`已获取 ${list.length} 个模型`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '获取模型失败');
    } finally {
      setLoadingModels(false);
    }
  };

  const test = async () => {
    if (!canTest) {
      toast.error(effectivePrimary ? '请填写 API Key' : '请先启用一个模型');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProviderConnection(
        {
          providerType: form.providerType,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          baseUrl: form.baseUrl.trim(),
          model: effectivePrimary,
        },
        providerId,
      );
      setTestResult(result);
      if (result.ok) toast.success(`连接成功，延迟 ${result.latencyMs}ms`);
      else toast.error(result.error || '连接测试失败');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  const toggleModel = (modelId: string) => {
    const enabled = form.enabledModels.includes(modelId);
    if (enabled && (form.primaryModel === modelId || form.utilityModel === modelId)) {
      toast.error('请先更换使用该模型的 Primary 或 Utility 设置');
      return;
    }
    updateForm({
      enabledModels: enabled
        ? form.enabledModels.filter((item) => item !== modelId)
        : [...form.enabledModels, modelId],
    });
  };

  const addManualModel = () => {
    const value = modelInput.trim();
    if (!value) return;
    if (!form.enabledModels.includes(value)) {
      updateForm({ enabledModels: [...form.enabledModels, value] });
    }
    setModelInput('');
  };

  const leaveEditor = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isDirty) return;
    event.preventDefault();
    const leave = await confirm({
      title: '放弃未保存的更改？',
      description: '返回列表后，本页尚未保存的 Provider 配置将丢失。',
      confirmText: '放弃更改',
      cancelText: '继续编辑',
      danger: true,
    });
    if (!leave) return;
    delete document.documentElement.dataset.settingsDirty;
    router.push('/settings/providers');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[var(--color-fg-2)]">
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
        正在加载 Provider...
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <div className="px-5 py-12 text-center">
          <p className="m-0 text-[13px] text-[var(--color-danger)]">{loadError}</p>
          <Link
            href="/settings/providers"
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-[var(--radius-btn)] border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-surface-hover)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
            返回 Provider 列表
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="pb-20 sm:pb-0"
    >
      <SettingsSectionHeader
        title={isNew ? '新建 Provider' : form.label || 'Provider 设置'}
        description={
          isNew
            ? '完成连接、模型和能力配置后即可用于分析。'
            : '连接凭证不会在页面中回显；留空表示继续使用已保存密钥。'
        }
        actions={
          <div className="hidden items-center gap-2 sm:flex">
            <Button type="button" onClick={test} disabled={testing || !canTest}>
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Plug className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              测试连接
            </Button>
            <Button type="submit" variant="primary" disabled={saving || !isDirty}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Save className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              保存更改
            </Button>
          </div>
        }
      />

      <Link
        href="/settings/providers"
        onClick={leaveEditor}
        className="mb-4 inline-flex min-h-9 items-center gap-2 text-[12.5px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        返回 Provider 列表
      </Link>

      <Card>
        <FormSection
          title="连接"
          description="服务类型、凭证和兼容 Endpoint。"
        >
          <Field label="名称" htmlFor="provider-label">
            <InputShell sans>
              <Input
                id="provider-label"
                value={form.label}
                onChange={(event) => updateForm({ label: event.target.value })}
                placeholder="例如：我的 DeepSeek"
              />
            </InputShell>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider 类型">
              <Select
                value={form.providerType}
                onValueChange={(value) =>
                  updateForm({ providerType: value as ProviderTypeStr })
                }
                sans
                className="w-full"
                ariaLabel="Provider 类型"
              >
                <SelectOption value="ANTHROPIC">Anthropic 原生</SelectOption>
                <SelectOption value="OPENAI_COMPATIBLE">OpenAI 兼容</SelectOption>
              </Select>
            </Field>
            <Field label="API Key" htmlFor="provider-key">
              <InputShell
                trailing={
                  <>
                    <button
                      type="button"
                      onClick={() => setShowApiKey((current) => !current)}
                      className="grid h-8 w-8 place-items-center rounded-[var(--radius-btn)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)]"
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    >
                      {showApiKey ? (
                        <EyeOff className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Eye className="h-4 w-4" strokeWidth={1.5} />
                      )}
                    </button>
                    {!isNew && hasApiKey && !clearApiKey && (
                      <button
                        type="button"
                        onClick={() => {
                          setClearApiKey(true);
                          updateForm({ apiKey: '' });
                        }}
                        className="h-8 rounded-[var(--radius-btn)] px-2 text-[11.5px] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                      >
                        清除
                      </button>
                    )}
                  </>
                }
              >
                <Input
                  id="provider-key"
                  type={showApiKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(event) => {
                    setClearApiKey(false);
                    updateForm({ apiKey: event.target.value });
                  }}
                  placeholder={
                    hasApiKey && !clearApiKey
                      ? '已保存；输入新 Key 可替换'
                      : 'sk-...'
                  }
                  autoComplete="off"
                />
              </InputShell>
              {!isNew && hasApiKey && !clearApiKey && (
                <p className="mt-1.5 text-[11.5px] text-[var(--color-fg-3)]">
                  已保存 {form.apiKey ? '新密钥待保存' : '一条密钥'}，服务端仅返回掩码状态。
                </p>
              )}
              {clearApiKey && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-[6px] border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3 py-2 text-[11.5px] text-[var(--color-warn)]">
                  保存后将清除当前密钥。
                  <button
                    type="button"
                    onClick={() => setClearApiKey(false)}
                    className="font-medium underline underline-offset-2"
                  >
                    撤销
                  </button>
                </div>
              )}
            </Field>
          </div>

          <Field label="Base URL" htmlFor="provider-base-url">
            <InputShell>
              <Input
                id="provider-base-url"
                value={form.baseUrl}
                onChange={(event) => updateForm({ baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1"
                inputMode="url"
              />
            </InputShell>
          </Field>

          {testResult && (
            <div
              role="status"
              className={cn(
                'flex items-start gap-2 rounded-[6px] border px-3 py-2.5 text-[12px]',
                testResult.ok
                  ? 'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]'
                  : 'border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
              )}
            >
              {testResult.ok ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              ) : (
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
              )}
              <span>
                {testResult.ok
                  ? `连接正常，响应延迟 ${testResult.latencyMs}ms`
                  : `连接失败：${testResult.error || '上游服务未返回可用响应'}`}
              </span>
            </div>
          )}
        </FormSection>

        <FormSection
          title="模型"
          description="启用可选模型，并指定分析与辅助任务的默认路由。"
        >
          <ModelPicker
            enabledModels={form.enabledModels}
            primaryModel={form.primaryModel}
            utilityModel={form.utilityModel}
            availableModels={models}
            modelInput={modelInput}
            loading={loadingModels}
            onLoad={loadModels}
            onToggle={toggleModel}
            onModelInputChange={setModelInput}
            onAddManual={addManualModel}
            onPrimaryChange={(value) => updateForm({ primaryModel: value })}
            onUtilityChange={(value) => updateForm({ utilityModel: value })}
          />
        </FormSection>

        <FormSection
          title="运行能力"
          description="设置默认路由与该 Provider 的可用状态。"
          last
        >
          <div className="space-y-2">
            <SwitchRow
              label="设为默认 Provider"
              desc="没有显式选择 Provider 时使用此配置。"
              checked={form.isDefault}
              onCheckedChange={(value) => updateForm({ isDefault: value })}
            />
            <SwitchRow
              label="启用 Provider"
              desc="停用后不会出现在分析页面的模型选择器中。"
              checked={form.enabled}
              onCheckedChange={(value) => updateForm({ enabled: value })}
            />
          </div>
        </FormSection>
      </Card>

      {!isNew && (
        <section className="mt-8 border-t border-[var(--color-danger-line)] pt-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="m-0 text-[14px] font-semibold text-[var(--color-danger)]">
                删除 Provider
              </h3>
              <p className="mb-0 mt-1 text-[12px] leading-[1.5] text-[var(--color-fg-2)]">
                删除后无法恢复，历史分析记录不会被删除。
              </p>
            </div>
            <Button type="button" variant="danger" onClick={remove}>
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              删除 Provider
            </Button>
          </div>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-elev)] p-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:hidden">
        <Button type="button" className="flex-1" onClick={test} disabled={testing || !canTest}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Plug className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
          测试
        </Button>
        <Button type="submit" variant="primary" className="flex-1" disabled={saving || !isDirty}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Save className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
          保存
        </Button>
      </div>
    </form>
  );
}

function FormSection({
  title,
  description,
  children,
  last,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section
      className={cn(
        'grid gap-5 px-4 py-6 sm:grid-cols-[150px_minmax(0,1fr)] sm:px-5 sm:py-7',
        !last && 'border-b border-[var(--color-border-soft)]',
      )}
    >
      <div>
        <h3 className="m-0 text-[14px] font-semibold">{title}</h3>
        <p className="mb-0 mt-1.5 text-[11.5px] leading-[1.55] text-[var(--color-fg-3)]">
          {description}
        </p>
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-2 block text-[12px] font-medium text-[var(--color-fg-2)]"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function formFromTemplate(templateId?: string): FormState {
  const template = BUILTIN_PROVIDER_CATALOG.find((item) => item.id === templateId);
  if (!template) return { ...EMPTY_FORM };
  return {
    ...EMPTY_FORM,
    label: template.label,
    providerType: template.providerType,
    baseUrl: template.baseUrl,
    enabledModels: [...template.defaultModels],
  };
}

function formFromDetail(detail: AiProviderSettingDetailDto): FormState {
  return {
    label: detail.label,
    providerType: detail.providerType,
    baseUrl: detail.baseUrl,
    apiKey: '',
    enabledModels: [...detail.enabledModels],
    primaryModel: detail.primaryModel ?? '',
    utilityModel: detail.utilityModel ?? '',
    isDefault: detail.isDefault,
    enabled: detail.enabled,
  };
}

function snapshot(form: FormState, clearApiKey: boolean): string {
  return JSON.stringify({ ...form, clearApiKey });
}

function validate(form: FormState): string | null {
  if (!form.label.trim()) return '请填写 Provider 名称';
  if (form.providerType === 'OPENAI_COMPATIBLE' && !form.baseUrl.trim()) {
    return 'OpenAI 兼容 Provider 需要 Base URL';
  }
  if (form.enabledModels.length === 0) return '请至少启用一个模型';
  if (form.primaryModel && !form.enabledModels.includes(form.primaryModel)) {
    return 'Primary 主模型必须在启用模型列表中';
  }
  if (form.utilityModel && !form.enabledModels.includes(form.utilityModel)) {
    return 'Utility 辅助模型必须在启用模型列表中';
  }
  return null;
}
