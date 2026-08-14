'use client';

import { Sparkles } from 'lucide-react';
import type { AnalysisMode, FocusWindow } from '@bourse/shared-types';
import { type AiProviderSettingDto } from '@/lib/api';
import { Button, Card, Dialog } from '@/components/ui';
import { AnalysisForm } from './analysis-form';

interface AnalysisLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  stockLabel: string;
  onStart: () => void;
  showEmptyState: boolean;
}

export function AnalysisLauncher({
  open,
  onOpenChange,
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
  stockLabel,
  onStart,
  showEmptyState,
}: AnalysisLauncherProps) {
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel="新建分析"
        titleSlot="新建分析"
        size="lg"
      >
        <AnalysisForm
          selectedMode={selectedMode}
          setSelectedMode={setSelectedMode}
          selectedFocusWindow={selectedFocusWindow}
          setSelectedFocusWindow={setSelectedFocusWindow}
          providerSettings={providerSettings}
          selectedSettingId={selectedSettingId}
          setSelectedSettingId={setSelectedSettingId}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          question={question}
          setQuestion={setQuestion}
          loading={loading}
          stockId={stockId}
          onStart={onStart}
          onCancel={() => onOpenChange(false)}
          embedded
        />
      </Dialog>

      {showEmptyState && (
        <Card className="mb-6">
          <div className="flex flex-col items-center gap-4 py-16 px-8 text-center">
            <Sparkles
              className="w-7 h-7 text-[var(--color-fg-3)]"
              strokeWidth={1.5}
            />
            <div>
              <p className="text-[14px] font-medium text-[var(--color-fg)]">
                暂无分析记录
              </p>
              <p className="mt-1 max-w-xs text-[12.5px] text-[var(--color-fg-2)] leading-[1.6]">
                对{' '}
                <span className="font-medium text-[var(--color-fg)]">
                  {stockLabel}
                </span>{' '}
                开启研究，获取公司质量、估值、风险等核心判断。
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              onClick={() => onOpenChange(true)}
            >
              <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
              开始 AI 分析
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
