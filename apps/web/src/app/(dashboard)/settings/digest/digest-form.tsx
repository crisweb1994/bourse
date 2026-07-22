'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plug, Plus, Trash2, Bell } from 'lucide-react';
import {
  Button,
  Card,
  Pill,
  SectionTag,
  SwitchRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
  useConfirm,
} from '@/components/ui';
import {
  deleteDigestSubscription,
  getDigestSubscription,
  putDigestSubscription,
  type DigestChannel,
  type DigestChannelType,
  type DigestMarket,
  type DigestSession,
  type DigestSubscriptionDto,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Daily Brief 订阅配置卡（docs/prd-daily-brief.md · task4 后端 / 前端 UI）。
 * 仿 web-search-card 的 per-user 单卡 upsert 模式：开关 + 推送市场/时点 +
 * 渠道列表（可增删）。channels 敏感字段后端已 mask；编辑时留空 = keep-existing。
 */

const MARKET_OPTIONS: { value: DigestMarket; label: string }[] = [
  { value: 'US', label: '美股' },
  { value: 'CN', label: 'A股' },
  { value: 'HK', label: '港股' },
];

const SESSION_OPTIONS: { value: DigestSession; label: string }[] = [
  { value: 'PRE', label: '盘前' },
  { value: 'POST', label: '盘后' },
];

const CHANNEL_OPTIONS: {
  value: DigestChannelType;
  label: string;
  /** 飞书/钉钉/企微/Slack 留 backlog（PRD Phase B），首批只 Webhook + 飞书 + TG。 */
  available: boolean;
}[] = [
  { value: 'TELEGRAM', label: 'Telegram', available: true },
  { value: 'FEISHU', label: '飞书', available: true },
  { value: 'WEBHOOK', label: '通用 Webhook', available: true },
  { value: 'DINGTALK', label: '钉钉', available: false },
  { value: 'WECOM', label: '企业微信', available: false },
  { value: 'SLACK', label: 'Slack', available: false },
];

interface FormState {
  enabled: boolean;
  earningsImmediateEnabled: boolean;
  markets: DigestMarket[];
  sessions: DigestSession[];
  channels: DigestChannel[];
}

const EMPTY_FORM: FormState = {
  enabled: false,
  earningsImmediateEnabled: false,
  markets: [],
  sessions: ['PRE', 'POST'],
  channels: [],
};

function fromDto(dto: DigestSubscriptionDto): FormState {
  return {
    enabled: dto.enabled,
    earningsImmediateEnabled: dto.earningsImmediateEnabled,
    markets: dto.markets as DigestMarket[],
    sessions: dto.sessions as DigestSession[],
    // 后端返回的 channels 已 mask（secret/botToken = ••••末四位）；前端原样持有，
    // 保存时空值由后端 mergeSecrets 保留旧凭证。
    channels: dto.channels as DigestChannel[],
  };
}

export function DigestSettingsForm() {
  const confirm = useConfirm();
  const [data, setData] = useState<DigestSubscriptionDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDigestSubscription()
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

  const updateForm = (patch: Partial<FormState>): void => {
    setForm((s) => ({ ...s, ...patch }));
  };

  const toggleMarket = (m: DigestMarket): void => {
    updateForm({
      markets: form.markets.includes(m)
        ? form.markets.filter((x) => x !== m)
        : [...form.markets, m],
    });
  };

  const toggleSession = (s: DigestSession): void => {
    updateForm({
      sessions: form.sessions.includes(s)
        ? form.sessions.filter((x) => x !== s)
        : [...form.sessions, s],
    });
  };

  const addChannel = (type: DigestChannelType): void => {
    const empty: DigestChannel = emptyChannel(type);
    updateForm({ channels: [...form.channels, empty] });
  };

  const updateChannel = (idx: number, patch: Partial<DigestChannel>): void => {
    updateForm({
      channels: form.channels.map((c, i) => (i === idx ? ({ ...c, ...patch } as DigestChannel) : c)),
    });
  };

  const removeChannel = (idx: number): void => {
    updateForm({ channels: form.channels.filter((_, i) => i !== idx) });
  };

  const canSave = useMemo(() => {
    if (saving) return false;
    if (form.enabled && form.markets.length === 0) return false; // 启用必须选至少一个市场
    return true;
  }, [form, saving]);

  const payload = () => ({
    markets: form.markets,
    sessions: form.sessions,
    channels: form.channels,
    enabled: form.enabled,
    earningsImmediateEnabled: form.earningsImmediateEnabled,
  });

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      const row = await putDigestSubscription(payload());
      setData(row);
      setForm(fromDto(row));
      toast.success('行情简报订阅已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!data) return;
    const ok = await confirm({
      title: '取消行情简报订阅？',
      description: '取消后不再生成或投递任何市场简报。',
      confirmText: '取消订阅',
      cancelText: '保留订阅',
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteDigestSubscription();
      setData(null);
      setForm(EMPTY_FORM);
      toast.success('已取消订阅');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="px-5 py-4 border-b border-[var(--color-border-soft)] flex items-center justify-between">
        <SectionTag>订阅状态</SectionTag>
        <Pill variant={data?.enabled ? 'emerald' : 'neutral'}>
          {data?.enabled ? '已启用' : '未启用'}
        </Pill>
      </div>

      <div className="p-5 space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-fg-2)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
            加载中…
          </div>
        ) : (
          <>
            <p className="text-[12px] text-[var(--color-fg-2)] leading-[1.55] max-w-[560px]">
              在每个市场开盘前 30 至 5 分钟、收盘后 5 至 30 分钟生成行情简报，
              并投递到已配置渠道。没有可用 Provider 时仅发送数字摘要。
            </p>

            <SwitchRow
              label="启用行情简报"
              desc="默认关闭；显式订阅才推送。关闭后不再生成、不投递。"
              checked={form.enabled}
              onCheckedChange={(v) => updateForm({ enabled: v })}
            />

            <SwitchRow
              label="财报即时通知"
              desc="自选股财报卡生成、更新或发生更正时立即推送；默认关闭。"
              checked={form.earningsImmediateEnabled}
              onCheckedChange={(v) => updateForm({ earningsImmediateEnabled: v })}
            />

            {/* 推送市场 */}
            <div>
              <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-2)]">
                推送市场
              </div>
              <div className="flex flex-wrap gap-2">
                {MARKET_OPTIONS.map((opt) => (
                  <ChipToggle
                    key={opt.value}
                    label={opt.label}
                    checked={form.markets.includes(opt.value)}
                    onClick={() => toggleMarket(opt.value)}
                  />
                ))}
              </div>
            </div>

            {/* 推送时点 */}
            <div>
              <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-2)]">
                推送时点
              </div>
              <div className="flex flex-wrap gap-2">
                {SESSION_OPTIONS.map((opt) => (
                  <ChipToggle
                    key={opt.value}
                    label={opt.label}
                    checked={form.sessions.includes(opt.value)}
                    onClick={() => toggleSession(opt.value)}
                  />
                ))}
              </div>
            </div>

            {/* 渠道列表 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-2)]">
                  推送渠道（可多个）
                </div>
                <AddChannelMenu onAdd={addChannel} />
              </div>

              {form.channels.length === 0 ? (
                <p className="text-[11.5px] text-[var(--color-fg-3)] py-3 px-3 rounded-md border border-dashed border-[var(--color-border-soft)]">
                  还没有渠道。点上方「+ 添加」配置飞书 / Telegram / Webhook。
                </p>
              ) : (
                <div className="space-y-2.5">
                  {form.channels.map((c, idx) => (
                    <ChannelEditor
                      key={idx}
                      channel={c}
                      masked={!!data}
                      onChange={(patch) => updateChannel(idx, patch)}
                      onRemove={() => removeChannel(idx)}
                      disabled={saving}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              {data ? (
                <Button variant="quiet" onClick={handleDelete} disabled={saving}>
                  <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                  取消订阅
                </Button>
              ) : (
                <span />
              )}
              <Button variant="primary" onClick={handleSave} disabled={!canSave}>
                {saving ? (
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Plug className="w-3 h-3" strokeWidth={1.5} />
                )}
                保存
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function ChipToggle({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-full text-[12.5px] font-mono border transition-colors',
        checked
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)]',
      )}
    >
      {label}
    </button>
  );
}

function AddChannelMenu({ onAdd }: { onAdd: (t: DigestChannelType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" type="button">
          <Plus className="w-3 h-3" strokeWidth={1.5} />
          添加渠道
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {CHANNEL_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            disabled={!opt.available}
            onSelect={() => onAdd(opt.value)}
          >
            {opt.label}
            {!opt.available && (
              <span className="ml-auto font-mono text-[10.5px] text-[var(--color-fg-3)]">
                后续版本
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChannelEditor({
  channel,
  masked,
  onChange,
  onRemove,
  disabled,
}: {
  channel: DigestChannel;
  /** true = 编辑模式（后端已 mask 凭证，空值 = keep-existing）。 */
  masked: boolean;
  onChange: (patch: Partial<DigestChannel>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const typeLabel =
    CHANNEL_OPTIONS.find((o) => o.value === channel.type)?.label ?? channel.type;
  return (
    <div className="space-y-3 border-t border-[var(--color-border-soft)] pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium flex items-center gap-1.5">
          <Bell className="w-3 h-3 text-[var(--color-fg-3)]" strokeWidth={1.5} />
          {typeLabel}
        </span>
        <Button variant="quiet" size="sm" onClick={onRemove} disabled={disabled}>
          <Trash2 className="w-3 h-3" strokeWidth={1.5} />
          <span className="sr-only">删除 {typeLabel} 渠道</span>
        </Button>
      </div>

      {channel.type === 'TELEGRAM' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <ChannelInput
            label="Bot Token"
            value={channel.botToken}
            placeholder={masked ? '••••（留空保持不变）' : '1234567890:ABC…'}
            onChange={(v) => onChange({ botToken: v })}
          />
          <ChannelInput
            label="Chat ID"
            value={channel.chatId}
            placeholder={masked ? '••••（留空保持不变）' : '给 @bot 发 /start 获取'}
            onChange={(v) => onChange({ chatId: v })}
          />
        </div>
      ) : (
        // WEBHOOK / FEISHU / DINGTALK / WECOM / SLACK：incoming webhook URL + 可选/必填 secret
        <>
          <ChannelInput
            label="Webhook URL"
            value={channel.url}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
            onChange={(v) => onChange({ url: v } as Partial<DigestChannel>)}
          />
          {('secret' in channel) && (
            <ChannelInput
              label={
                channel.type === 'DINGTALK' || channel.type === 'WEBHOOK'
                  ? '签名 Secret'
                  : '签名 Secret（可选）'
              }
              value={channel.secret ?? ''}
              placeholder={masked ? '••••（留空保持不变）' : '签名密钥'}
              onChange={(v) => onChange({ secret: v } as Partial<DigestChannel>)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ChannelInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block mb-1 text-[10.5px] font-mono uppercase tracking-[0.04em] text-[var(--color-fg-3)]">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2.5 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elev)] font-mono text-[12px] focus:outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

/** 新建一个空渠道（凭证待填）。 */
function emptyChannel(type: DigestChannelType): DigestChannel {
  switch (type) {
    case 'TELEGRAM':
      return { type: 'TELEGRAM', botToken: '', chatId: '' };
    case 'WEBHOOK':
      return { type: 'WEBHOOK', url: '', secret: '' };
    case 'FEISHU':
      return { type: 'FEISHU', url: '' };
    case 'DINGTALK':
      return { type: 'DINGTALK', url: '', secret: '' };
    case 'WECOM':
      return { type: 'WECOM', url: '' };
    case 'SLACK':
      return { type: 'SLACK', url: '' };
  }
}
