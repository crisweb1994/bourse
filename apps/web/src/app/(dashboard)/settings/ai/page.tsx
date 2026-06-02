'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Star,
  Trash2,
  X,
  HelpCircle,
} from 'lucide-react';
import {
  createAiProviderSetting,
  deleteAiProviderSetting,
  fetchProviderModels,
  listAiProviderSettings,
  testProviderConnection,
  updateAiProviderSetting,
  updateUserPreferences,
  type AiModelOptionDto,
  type AiProviderSettingDto,
  type BuiltinProviderTemplate,
  type ProviderTypeStr,
} from '@/lib/api';
import { API_URL } from '@/lib/utils';
import { BUILTIN_PROVIDER_CATALOG } from '@/lib/ai-provider-catalog';
import { WebSearchSettingCard } from './web-search-card';
import {
  Button,
  Card,
  PageHeader,
  SectionTag,
  Select,
  SelectOption,
  SwitchRow,
  toast,
  useConfirm,
} from '@/components/ui';
import { cn } from '@/lib/utils';

interface FormState {
  label: string;
  providerType: ProviderTypeStr;
  baseUrl: string;
  apiKey: string;
  enabledModels: string[];
  primaryModel: string;
  utilityModel: string;
  supportsWebSearch: boolean;
  supportsTools: boolean;
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
  supportsWebSearch: false,
  supportsTools: true,
  isDefault: false,
  enabled: true,
};

function toForm(s: AiProviderSettingDto): FormState {
  return {
    label: s.label,
    providerType: s.providerType,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey ?? '',
    enabledModels: [...s.enabledModels],
    primaryModel: s.primaryModel ?? '',
    utilityModel: s.utilityModel ?? '',
    supportsWebSearch: s.supportsWebSearch,
    supportsTools: s.supportsTools,
    isDefault: s.isDefault,
    enabled: s.enabled,
  };
}

const inputCls =
  'w-full rounded-[var(--radius-btn)] border border-[var(--color-border)] ' +
  'bg-[var(--color-bg)] px-3 py-2 text-[13px] outline-none ' +
  'focus:border-[var(--color-fg)] transition-colors';

const inputMonoCls = cn(inputCls, 'font-mono text-[12.5px]');

export default function AiSettingsPage() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<AiProviderSettingDto[]>([]);
  const catalog = BUILTIN_PROVIDER_CATALOG;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<AiModelOptionDto[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  } | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const activeSetting = useMemo(
    () => settings.find((s) => s.id === activeId) ?? null,
    [settings, activeId],
  );
  const isNew = activeId === '__new__';

  // RFC rfc-evidence-pack-web-search-fallback: page-level user pref.
  // Persisted via PATCH /api/auth/preferences; loaded once on mount.
  const [allowWebSearchFallback, setAllowWebSearchFallback] = useState(false);
  const [savingFallback, setSavingFallback] = useState(false);

  // plan-v2 Wave 4.5 — WebSearchSetting CRUD removed. Adapter picked from env.

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/auth/me`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (cancelled || !u) return;
        setAllowWebSearchFallback(u.allowWebSearchFallback === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFallback = async (next: boolean) => {
    setSavingFallback(true);
    const prev = allowWebSearchFallback;
    setAllowWebSearchFallback(next);
    try {
      await updateUserPreferences({ allowWebSearchFallback: next });
      toast.success(next ? '已启用 web_search 兜底' : '已关闭 web_search 兜底');
    } catch (err) {
      setAllowWebSearchFallback(prev);
      toast.error(err instanceof Error ? err.message : '保存偏好失败');
    } finally {
      setSavingFallback(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAiProviderSettings()
      .then((list) => {
        if (cancelled) return;
        setSettings(list);
        if (list.length > 0) {
          setActiveId(list[0].id);
          setForm(toForm(list[0]));
        }
      })
      .catch(
        (err) =>
          !cancelled && toast.error(err.message || '加载 AI 设置失败'),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectSetting = (id: string) => {
    const s = settings.find((x) => x.id === id);
    if (!s) return;
    setActiveId(id);
    setForm(toForm(s));
    setModels([]);
    setTestResult(null);
    setShowApiKey(false);
  };

  const startNew = (template?: BuiltinProviderTemplate) => {
    setActiveId('__new__');
    setModels([]);
    setTestResult(null);
    if (template) {
      setForm({
        ...EMPTY_FORM,
        label: template.label,
        providerType: template.providerType,
        baseUrl: template.baseUrl,
        enabledModels: [...template.defaultModels],
        supportsWebSearch: template.supportsWebSearch,
        supportsTools: template.supportsTools,
        isDefault: settings.length === 0,
      });
    } else {
      setForm({ ...EMPTY_FORM, isDefault: settings.length === 0 });
    }
  };

  const updateForm = (patch: Partial<FormState>) =>
    setForm((cur) => ({ ...cur, ...patch }));

  const save = async () => {
    if (form.enabledModels.length === 0) {
      toast.error('请至少启用一个模型');
      return;
    }
    const primary = form.primaryModel.trim() || form.enabledModels[0];
    if (!form.enabledModels.includes(primary)) {
      toast.error('主模型必须在启用模型列表中');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        label: form.label,
        providerType: form.providerType,
        baseUrl: form.baseUrl,
        enabledModels: form.enabledModels,
        primaryModel: primary,
        utilityModel: form.utilityModel.trim(),
        supportsWebSearch: form.supportsWebSearch,
        supportsTools: form.supportsTools,
        isDefault: form.isDefault,
        enabled: form.enabled,
      };
      payload.apiKey = form.apiKey.trim();

      let saved: AiProviderSettingDto;
      if (isNew) {
        saved = await createAiProviderSetting(payload);
      } else if (activeId) {
        saved = await updateAiProviderSetting(activeId, payload);
      } else {
        throw new Error('No active setting');
      }
      const fresh = await listAiProviderSettings();
      setSettings(fresh);
      setActiveId(saved.id);
      setForm(toForm(saved));
      toast.success('已保存');
    } catch (err: any) {
      toast.error(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!activeId || isNew) return;
    const ok = await confirm({
      title: `删除 "${form.label}"？`,
      description:
        '该 Provider 将被永久删除，依赖它的分析会自动回退到默认配置。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAiProviderSetting(activeId);
      const fresh = await listAiProviderSettings();
      setSettings(fresh);
      if (fresh.length > 0) {
        setActiveId(fresh[0].id);
        setForm(toForm(fresh[0]));
      } else {
        setActiveId(null);
      }
      toast.success('已删除');
    } catch (err: any) {
      toast.error(err.message || '删除失败');
    }
  };

  const loadModels = async () => {
    if (!form.baseUrl.trim()) {
      toast.error('请先填写 Base URL');
      return;
    }
    setLoadingModels(true);
    try {
      const list = await fetchProviderModels({
        providerType: form.providerType,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
      });
      setModels(list);
      toast.success(`已拉取 ${list.length} 个模型`);
    } catch (err: any) {
      toast.error(err.message || '拉取模型失败');
    } finally {
      setLoadingModels(false);
    }
  };

  const test = async () => {
    if (!form.apiKey.trim()) {
      toast.error('请先填写 API Key');
      return;
    }
    if (form.enabledModels.length === 0) {
      toast.error('请至少启用一个模型');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProviderConnection({
        providerType: form.providerType,
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.enabledModels[0],
      });
      setTestResult(result);
      if (result.ok) {
        toast.success(`连接成功 · ${result.latencyMs}ms`);
      } else {
        toast.error(`连接失败 · ${result.error || 'unknown'}`);
      }
    } catch (err: any) {
      toast.error(err.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const toggleModel = (modelId: string) => {
    updateForm({
      enabledModels: form.enabledModels.includes(modelId)
        ? form.enabledModels.filter((m) => m !== modelId)
        : [...form.enabledModels, modelId],
    });
  };

  const addManualModel = () => {
    const m = modelInput.trim();
    if (!m) return;
    if (!form.enabledModels.includes(m)) {
      updateForm({ enabledModels: [...form.enabledModels, m] });
    }
    setModelInput('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--color-fg-2)]">
        <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
        加载 AI 设置…
      </div>
    );
  }

  return (
    <>
      <PageHeader
        tag="账户 · AI 模型"
        title="AI 模型设置"
        subtitle="配置多个大模型 Provider — Anthropic 原生 / OpenAI 兼容（DeepSeek · Qwen · Kimi · Moonshot 等）。API Key 明文落库，仅单租户私有部署适用。"
      />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Left rail */}
        <aside>
          <Card>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-soft)]">
              <SectionTag>已配置 · {settings.length}</SectionTag>
              <Button
                size="sm"
                onClick={() => startNew()}
                title="新建空白自定义配置"
              >
                <Plus className="w-3 h-3" strokeWidth={1.5} /> 自定义
              </Button>
            </div>

            <div className="p-2">
              {settings.length === 0 && !isNew && (
                <div className="px-3 py-4 text-center text-[12px] text-[var(--color-fg-3)]">
                  从下方选择 Provider 模板开始配置 ↓
                </div>
              )}

              {settings.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectSetting(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[6px] border px-2.5 py-2 text-left mb-0.5 transition-colors',
                    activeId === s.id
                      ? 'border-[var(--color-border)] bg-[var(--color-bg)]'
                      : 'border-transparent hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full shrink-0',
                      s.enabled
                        ? 'bg-[var(--color-accent)]'
                        : 'bg-[var(--color-fg-4)]',
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="truncate text-[13px] font-medium">
                        {s.label}
                      </span>
                      {s.isDefault && (
                        <Star
                          className="w-3 h-3 shrink-0 fill-[var(--color-fg)] text-[var(--color-fg)]"
                          strokeWidth={1.5}
                        />
                      )}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--color-fg-3)] tracking-[0.02em]">
                      {s.providerType === 'ANTHROPIC'
                        ? 'Anthropic'
                        : 'OpenAI 兼容'}
                      {s.enabledModels.length > 0 &&
                        ` · ${s.enabledModels.length} 模型`}
                    </div>
                  </div>
                </button>
              ))}

              {isNew && (
                <div className="flex items-center gap-2 rounded-[6px] border border-[var(--color-fg)] px-2.5 py-2 text-[13px]">
                  <Plus className="w-3 h-3" strokeWidth={1.5} />
                  <span className="font-medium">新建中…</span>
                </div>
              )}
            </div>

            {catalog.length > 0 && (
              <div className="border-t border-[var(--color-border-soft)] p-2">
                <div className="px-3 py-2">
                  <SectionTag>可添加 · {catalog.length}</SectionTag>
                </div>
                {catalog.map((t) => {
                  const alreadyConfigured = settings.some(
                    (s) =>
                      s.label === t.label ||
                      (t.baseUrl && s.baseUrl === t.baseUrl),
                  );
                  return (
                    <button
                      key={t.id}
                      onClick={() => startNew(t)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left mb-0.5 transition-colors hover:bg-[var(--color-surface-hover)]',
                        alreadyConfigured && 'opacity-50',
                      )}
                      title={
                        alreadyConfigured
                          ? '已存在同名 / 同 URL 配置，再次添加将创建新副本'
                          : '点击预填表单'
                      }
                    >
                      <div
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[10.5px] font-bold text-white border border-[var(--color-border)]"
                        style={{ background: t.iconColor || '#525252' }}
                      >
                        {t.iconText}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[13px] font-medium">
                          {t.label}
                        </div>
                        <div className="truncate font-mono text-[10.5px] text-[var(--color-fg-3)] tracking-[0.02em]">
                          {t.providerType === 'ANTHROPIC'
                            ? '原生'
                            : 'OpenAI 兼容'}
                          {alreadyConfigured && ' · 已配置'}
                        </div>
                      </div>
                      <Plus
                        className="w-3 h-3 shrink-0 text-[var(--color-fg-3)]"
                        strokeWidth={1.5}
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </aside>

        {/* Right edit panel */}
        <section>
          <Card>
            {activeId === null && !isNew ? (
              <div className="py-16 text-center text-[13px] text-[var(--color-fg-3)]">
                选择左侧的 Provider 进行编辑，或点击「新增」创建新配置。
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-5 py-3.5">
                  <h2 className="m-0 text-[15px] font-semibold">
                    {isNew ? '新建 Provider' : form.label || '编辑'}
                  </h2>
                  <div className="flex items-center gap-2">
                    <Button onClick={test} disabled={testing}>
                      {testing ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Plug className="w-3.5 h-3.5" strokeWidth={1.5} />
                      )}
                      测试连接
                    </Button>
                    {!isNew && (
                      <Button variant="danger" onClick={remove}>
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                        删除
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      onClick={save}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2
                          className="w-3.5 h-3.5 animate-spin"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Save className="w-3.5 h-3.5" strokeWidth={1.5} />
                      )}
                      保存
                    </Button>
                  </div>
                </div>

                <div className="px-5 py-5 space-y-5">
                  <Field label="名称">
                    <input
                      value={form.label}
                      onChange={(e) =>
                        updateForm({ label: e.target.value })
                      }
                      placeholder="例如：我的 DeepSeek"
                      className={inputCls}
                    />
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Provider 类型">
                      <Select
                        value={form.providerType}
                        onValueChange={(v) =>
                          updateForm({ providerType: v as ProviderTypeStr })
                        }
                        sans
                        className="w-full"
                      >
                        <SelectOption value="ANTHROPIC">
                          Anthropic · 原生
                        </SelectOption>
                        <SelectOption value="OPENAI_COMPATIBLE">
                          OpenAI 兼容
                        </SelectOption>
                      </Select>
                    </Field>
                    <Field label="API Key">
                      <div className="flex gap-1.5">
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          value={form.apiKey}
                          onChange={(e) =>
                            updateForm({ apiKey: e.target.value })
                          }
                          placeholder="sk-…"
                          className={inputMonoCls}
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          className="shrink-0 rounded-[var(--radius-btn)] border border-[var(--color-border)] px-2.5 font-mono text-[11px] hover:bg-[var(--color-surface-hover)]"
                        >
                          {showApiKey ? '隐藏' : '查看'}
                        </button>
                      </div>
                    </Field>
                  </div>

                  <Field label="Base URL">
                    <input
                      value={form.baseUrl}
                      onChange={(e) =>
                        updateForm({ baseUrl: e.target.value })
                      }
                      placeholder="https://api.example.com/v1"
                      className={inputMonoCls}
                    />
                  </Field>

                  {/* 能力开关 */}
                  <div>
                    <div className="mb-2.5">
                      <SectionTag>能力开关</SectionTag>
                    </div>
                    <div className="space-y-1.5">
                      <SwitchRow
                        label="支持 Web Search"
                        desc="provider 是否支持内置联网搜索工具（Anthropic / OpenAI 原生支持）"
                        checked={form.supportsWebSearch}
                        onCheckedChange={(v) =>
                          updateForm({ supportsWebSearch: v })
                        }
                      />
                      <SwitchRow
                        label="支持 Function Calling / Tools"
                        desc="关闭则结构化输出回退到 JSON-mode prompting（DeepSeek / Kimi 等建议关闭）"
                        checked={form.supportsTools}
                        onCheckedChange={(v) => updateForm({ supportsTools: v })}
                      />
                      <SwitchRow
                        label="设为默认 Provider"
                        desc="未指定时自动使用该 provider"
                        checked={form.isDefault}
                        onCheckedChange={(v) => updateForm({ isDefault: v })}
                      />
                      <SwitchRow
                        label="启用"
                        desc="禁用后该 provider 不会出现在分析下拉框中"
                        checked={form.enabled}
                        onCheckedChange={(v) => updateForm({ enabled: v })}
                      />
                    </div>
                  </div>

                  {/* 模型列表 */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <SectionTag>启用的模型</SectionTag>
                      <Button
                        size="sm"
                        onClick={loadModels}
                        disabled={loadingModels}
                      >
                        {loadingModels ? (
                          <Loader2
                            className="w-3 h-3 animate-spin"
                            strokeWidth={1.5}
                          />
                        ) : (
                          <RefreshCw
                            className="w-3 h-3"
                            strokeWidth={1.5}
                          />
                        )}
                        从 /v1/models 拉取
                      </Button>
                    </div>

                    <div className="mb-2 flex flex-wrap gap-1.5 min-h-[28px]">
                      {form.enabledModels.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-2 py-0.5 font-mono text-[11.5px]"
                        >
                          {m}
                          <button
                            onClick={() => toggleModel(m)}
                            className="opacity-50 hover:opacity-100"
                          >
                            <X className="w-3 h-3" strokeWidth={1.5} />
                          </button>
                        </span>
                      ))}
                      {form.enabledModels.length === 0 && (
                        <span className="text-[12px] text-[var(--color-fg-3)]">
                          暂无启用模型，可下方手动输入或拉取后勾选
                        </span>
                      )}
                    </div>

                    <div className="mb-2 flex gap-1.5">
                      <input
                        value={modelInput}
                        onChange={(e) => setModelInput(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === 'Enter' &&
                          (e.preventDefault(), addManualModel())
                        }
                        placeholder="手动输入 model id，回车添加"
                        className={cn(inputMonoCls, 'flex-1')}
                      />
                      <Button size="sm" onClick={addManualModel}>
                        添加
                      </Button>
                    </div>

                    {models.length > 0 && (
                      <div className="max-h-48 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
                        {models.map((m) => {
                          const checked = form.enabledModels.includes(m.id);
                          return (
                            <button
                              key={m.id}
                              onClick={() => toggleModel(m.id)}
                              className="flex w-full items-center gap-2.5 border-b border-[var(--color-border-soft)] px-3 py-2 text-left text-[12.5px] last:border-b-0 hover:bg-[var(--color-surface-hover)]"
                            >
                              <div
                                className={cn(
                                  'flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border',
                                  checked
                                    ? 'border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-bg)]'
                                    : 'border-[var(--color-border)]',
                                )}
                              >
                                {checked && (
                                  <Check
                                    className="w-2.5 h-2.5"
                                    strokeWidth={1.5}
                                  />
                                )}
                              </div>
                              <span className="font-mono">{m.id}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* primaryModel */}
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <SectionTag>
                        主模型 · Primary
                        <span className="text-[var(--color-danger)] ml-1">*</span>
                      </SectionTag>
                      <HelpCircle
                        className="w-3 h-3 text-[var(--color-fg-3)] cursor-help"
                        strokeWidth={1.5}
                        aria-label="主模型用于主分析流式生成、报告主体、web_search 工具调用 + 证据归一化、debate 等。"
                      />
                    </div>
                    <Select
                      value={form.primaryModel || '__auto'}
                      onValueChange={(v) =>
                        updateForm({ primaryModel: v === '__auto' ? '' : v })
                      }
                      className="w-full"
                    >
                      <SelectOption value="__auto">
                        — 自动取启用列表第一项 —
                      </SelectOption>
                      {form.enabledModels.map((m) => (
                        <SelectOption key={m} value={m}>
                          {m}
                        </SelectOption>
                      ))}
                    </Select>
                    {form.primaryModel &&
                      !form.enabledModels.includes(form.primaryModel) && (
                        <div className="mt-1 text-[12px] text-[var(--color-danger)]">
                          当前 primaryModel = &quot;{form.primaryModel}&quot;
                          不在启用列表中，保存会被拒绝
                        </div>
                      )}
                  </div>

                  {/* utilityModel */}
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <SectionTag>次模型 · Utility</SectionTag>
                      <HelpCircle
                        className="w-3 h-3 text-[var(--color-fg-3)] cursor-help"
                        strokeWidth={1.5}
                        aria-label="用于结构化 JSON、摘要、查询改写等。配同厂商小模型可省 50–80% 成本。"
                      />
                    </div>
                    <Select
                      value={form.utilityModel || '__none'}
                      onValueChange={(v) =>
                        updateForm({ utilityModel: v === '__none' ? '' : v })
                      }
                      className="w-full"
                    >
                      <SelectOption value="__none">
                        — 不设置，全部使用主模型 —
                      </SelectOption>
                      {form.enabledModels.map((m) => (
                        <SelectOption key={m} value={m}>
                          {m}
                        </SelectOption>
                      ))}
                      {form.utilityModel &&
                        !form.enabledModels.includes(form.utilityModel) && (
                          <SelectOption value={form.utilityModel}>
                            {form.utilityModel}（未在启用列表）
                          </SelectOption>
                        )}
                    </Select>
                  </div>
                </div>
              </>
            )}
          </Card>
        </section>
      </div>

      {/* plan-v2 §17.4.4 — per-user web search adapter config. Restored
          table; UI consumes hasAnthropic to disable CUSTOM_ONLY when the
          user is on Claude (SDK can't host a pluggable web_search tool). */}
      <WebSearchSettingCard
        hasAnthropic={settings.some(
          (s) => s.enabled && s.providerType === 'ANTHROPIC',
        )}
      />

      {/* RFC rfc-evidence-pack-web-search-fallback: page-level preference.
          Sits below the per-provider grid so it's clearly separate from
          provider-scoped settings. */}
      <Card className="mt-4">
        <div className="px-5 py-4 border-b border-[var(--color-border-soft)]">
          <SectionTag>数据源兜底</SectionTag>
        </div>
        <div className="px-5 py-4">
          <SwitchRow
            label="数据接口失败时启用 web_search 兜底"
            desc={
              <>
                A 股实时数据 API（行情 / 财报 / 北向 / 龙虎榜 / 解禁 / 一致预期）
                出现 401 / 网络错 / 配额耗尽等硬故障时，自动切到 AI 网页搜索
                完成分析。
                <br />
                <span className="text-[var(--color-warn)]">
                  代价：北向资金 / 龙虎榜 / 一致预期 EPS 等私有数据
                  无法替代，相关维度会被主动跳过；Debate 在此模式下置信度上限为
                  MEDIUM。
                </span>
              </>
            }
            checked={allowWebSearchFallback}
            onCheckedChange={toggleFallback}
            disabled={savingFallback}
          />
        </div>
      </Card>
    </>
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
      <div className="mb-2">
        <SectionTag>{label}</SectionTag>
      </div>
      {children}
      {hint && (
        <p className="mt-1 m-0 text-[11.5px] text-[var(--color-fg-3)]">
          {hint}
        </p>
      )}
    </div>
  );
}

