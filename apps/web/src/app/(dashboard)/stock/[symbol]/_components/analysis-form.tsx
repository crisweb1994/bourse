'use client';

import { Loader2, MessageSquareText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ActiveAnalysisType } from '@bourse/shared-types';
import { type AiProviderSettingDto } from '@/lib/api';
import {
  Button,
  Card,
  SectionTag,
  Select,
  SelectGroup,
  SelectOption,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { ANALYSIS_TYPES } from '../stock-page-ui';

// ============================================================
// AnalysisForm
// ============================================================

interface AnalysisFormProps {
  selectedType: ActiveAnalysisType;
  setSelectedType: (v: ActiveAnalysisType) => void;
  providerSettings: AiProviderSettingDto[];
  selectedSettingId: string;
  setSelectedSettingId: (v: string) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  question: string;
  setQuestion: (v: string) => void;
  loading: boolean;
  stockId: string | null;
  onStart: () => void;
  onCancel?: () => void;
  /** When true (Dialog mode), drop outer Card chrome / sticky title bar
   *  since the Dialog already owns those. */
  embedded?: boolean;
}

export function AnalysisForm({
  selectedType,
  setSelectedType,
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
  const isComprehensive = selectedType === 'COMPREHENSIVE';

  const body = (
    <>
      <div className="px-5 py-4">
        <div className="mb-5">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label
              htmlFor="analysis-question"
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-2)]"
            >
              <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.5} />
              本次想重点研究什么？
              <span className="text-[var(--color-fg-3)]">（可选）</span>
            </label>
            <span className="font-mono text-[10.5px] text-[var(--color-fg-3)]">
              {question.length}/500
            </span>
          </div>
          <textarea
            id="analysis-question"
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：最新财报里的毛利率下滑是短期波动，还是竞争格局已经改变？"
            className={
              'min-h-[84px] w-full resize-y rounded-[var(--radius-btn)] border outline-none ' +
              'border-[var(--color-border)] bg-[var(--color-bg-elev)] px-3 py-2.5 ' +
              'text-[13.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-3)] ' +
              'leading-[1.6] transition-colors focus:border-[var(--color-fg)]'
            }
          />
          <p className="mt-1.5 text-[11.5px] leading-[1.5] text-[var(--color-fg-3)]">
            留空按所选维度完整分析；填写后，报告会优先围绕这个问题组织证据和结论。
          </p>
        </div>

        <div className="mb-1.5 text-[12px] text-[var(--color-fg-2)]">
          分析类型
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          {ANALYSIS_TYPES.map((t) => {
            const active = selectedType === t.value;
            return (
              <button
                type="button"
                key={t.value}
                onClick={() => setSelectedType(t.value)}
                className={cn(
                  'rounded-[var(--radius-btn)] border px-3 py-1.5 text-[13px] transition-colors',
                  active
                    ? 'bg-[var(--color-fg)] text-[var(--color-bg)] border-[var(--color-fg)]'
                    : 'bg-[var(--color-bg)] text-[var(--color-fg)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="text-[13px] text-[var(--color-fg-2)]">模型：</span>
          <Select
            value={
              selectedSettingId
                ? `${selectedSettingId}::${selectedModel}`
                : '__default'
            }
            onValueChange={(v) => {
              if (v === '__default') {
                setSelectedSettingId('');
                setSelectedModel('');
                return;
              }
              const [sid, ...modelParts] = v.split('::');
              setSelectedSettingId(sid);
              setSelectedModel(modelParts.join('::'));
            }}
            className="min-w-[220px]"
          >
            <SelectOption value="__default">系统默认</SelectOption>
            {providerSettings.map((s) => (
              <SelectGroup
                key={s.id}
                label={`${s.label}${s.isDefault ? '（默认）' : ''}`}
              >
                {s.enabledModels.length === 0 ? (
                  <SelectOption value={`${s.id}::`} disabled>
                    （无启用模型）
                  </SelectOption>
                ) : (
                  s.enabledModels.map((m) => (
                    <SelectOption
                      key={`${s.id}::${m}`}
                      value={`${s.id}::${m}`}
                    >
                      {m}
                    </SelectOption>
                  ))
                )}
              </SelectGroup>
            ))}
          </Select>
          {providerSettings.length === 0 && (
            <Link
              href="/settings/providers"
              className="font-mono text-[11px] text-[var(--color-fg-2)] border-b border-[var(--color-fg-4)] hover:border-[var(--color-fg)]"
            >
              添加模型 →
            </Link>
          )}
        </div>

        {isComprehensive && (
          <p className="text-[12px] text-[var(--color-warn)] mb-4">
            综合分析将依次运行 8 个维度分析，然后生成总览报告。耗时较长，请耐心等待。
          </p>
        )}

        <Button
          variant="primary"
          onClick={onStart}
          disabled={loading || !stockId}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
          )}
          {isComprehensive ? '开始综合分析' : '开始分析'}
        </Button>
      </div>
    </>
  );

  // Embedded inside a Dialog (S3-7) — drop the outer Card chrome since the
  // Dialog already provides backdrop / border / title bar / radius.
  if (embedded) return body;

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--color-border-soft)]">
        <SectionTag>开启新分析</SectionTag>
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-[12px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"
          >
            取消
          </button>
        )}
      </div>
      {body}
    </Card>
  );
}
