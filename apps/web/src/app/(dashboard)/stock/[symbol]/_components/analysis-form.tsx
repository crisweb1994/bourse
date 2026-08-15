'use client';

import { Loader2, MessageSquareText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { AnalysisMode, FocusWindow } from '@bourse/shared-types';
import type { AiProviderSettingDto } from '@/lib/api';
import { ANALYSIS_MODE_OPTIONS, FOCUS_WINDOW_OPTIONS } from '../stock-page-ui';
import { Button, Card, SectionTag, Select, SelectGroup, SelectOption } from '@/components/ui';
import { cn } from '@/lib/utils';

interface AnalysisFormProps {
  selectedMode: AnalysisMode;
  setSelectedMode: (value: AnalysisMode) => void;
  selectedFocusWindow: FocusWindow;
  setSelectedFocusWindow: (value: FocusWindow) => void;
  providerSettings: AiProviderSettingDto[];
  selectedSettingId: string;
  setSelectedSettingId: (value: string) => void;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  question: string;
  setQuestion: (value: string) => void;
  loading: boolean;
  stockId: string | null;
  onStart: () => void;
  onCancel?: () => void;
  embedded?: boolean;
}

export function AnalysisForm({
  selectedMode,
  setSelectedMode,
  selectedFocusWindow,
  setSelectedFocusWindow,
  providerSettings,
  selectedSettingId,
  setSelectedSettingId,
  selectedModel,
  setSelectedModel,
  question,
  setQuestion,
  loading,
  stockId,
  onStart,
  onCancel,
  embedded,
}: AnalysisFormProps) {
  const body = (
    <div className="px-5 py-4">
      <div className="mb-5">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label htmlFor="analysis-question" className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-2)]">
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.5} />
            本次想重点研究什么？<span className="text-[var(--color-fg-3)]">（可选）</span>
          </label>
          <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">{question.length}/500</span>
        </div>
        <textarea
          id="analysis-question"
          value={question}
          maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：最新财报里的毛利率下滑是短期波动，还是竞争格局已经改变？"
          className="min-h-[84px] w-full resize-y rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-3 py-2.5 text-[13.5px] leading-[1.6] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-3)] focus:border-[var(--color-fg)]"
        />
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-[var(--color-fg-3)]">
          重点问题会影响证据组织顺序，不会跳过五个研究模块。
        </p>
      </div>

      <div className="mb-1.5 text-[12px] text-[var(--color-fg-2)]">研究模式</div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {ANALYSIS_MODE_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            onClick={() => setSelectedMode(option.value)}
            className={cn(
              'rounded-[var(--radius-btn)] border px-3 py-2 text-left transition-colors',
              selectedMode === option.value
                ? 'border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-bg)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]',
            )}
          >
            <span className="block text-[13px] font-medium">{option.label}</span>
            <span className={cn('mt-0.5 block text-[11px]', selectedMode === option.value ? 'text-[var(--color-bg)]/70' : 'text-[var(--color-fg-3)]')}>
              {option.value === 'QUICK' ? '先看最重要的事实和风险' : '更完整的证据和情景分析'}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-1.5 text-[12px] text-[var(--color-fg-2)]">重点时间</div>
      <div className="mb-4 grid grid-cols-4 gap-2">
        {FOCUS_WINDOW_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            onClick={() => setSelectedFocusWindow(option.value)}
            className={cn(
              'rounded-[var(--radius-btn)] border px-2 py-1.5 text-[12px] transition-colors',
              selectedFocusWindow === option.value
                ? 'border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-bg)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)]',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-[var(--color-fg-2)]">模型：</span>
        <Select
          value={selectedSettingId ? `${selectedSettingId}::${selectedModel}` : '__default'}
          onValueChange={(value) => {
            if (value === '__default') {
              setSelectedSettingId('');
              setSelectedModel('');
              return;
            }
            const [settingId, ...modelParts] = value.split('::');
            setSelectedSettingId(settingId);
            setSelectedModel(modelParts.join('::'));
          }}
          className="min-w-[220px]"
        >
          <SelectOption value="__default">系统默认</SelectOption>
          {providerSettings.map((setting) => (
            <SelectGroup key={setting.id} label={`${setting.label}${setting.isDefault ? '（默认）' : ''}`}>
              {setting.enabledModels.length === 0 ? (
                <SelectOption value={`${setting.id}::`} disabled>（无启用模型）</SelectOption>
              ) : setting.enabledModels.map((model) => (
                <SelectOption key={`${setting.id}::${model}`} value={`${setting.id}::${model}`}>{model}</SelectOption>
              ))}
            </SelectGroup>
          ))}
        </Select>
        {providerSettings.length === 0 && (
          <Link href="/settings/providers" className="border-b border-[var(--color-fg-4)] font-mono text-[11px] text-[var(--color-fg-2)] hover:border-[var(--color-fg)]">
            添加模型 →
          </Link>
        )}
      </div>

      <Button variant="primary" onClick={onStart} disabled={loading || !stockId}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />}
        开始研究
      </Button>
    </div>
  );

  if (embedded) return body;
  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-5 py-3.5">
        <SectionTag>开启新研究</SectionTag>
        {onCancel && <button onClick={onCancel} className="text-[12px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)]">取消</button>}
      </div>
      {body}
    </Card>
  );
}
