'use client';

import { Loader2, Plus, RefreshCw, X } from 'lucide-react';
import {
  Button,
  Input,
  InputShell,
  Select,
  SelectOption,
} from '@/components/ui';
import type { AiModelOptionDto } from '@/lib/api';

export function ModelPicker({
  enabledModels,
  primaryModel,
  utilityModel,
  availableModels,
  modelInput,
  loading,
  onLoad,
  onToggle,
  onModelInputChange,
  onAddManual,
  onPrimaryChange,
  onUtilityChange,
}: {
  enabledModels: string[];
  primaryModel: string;
  utilityModel: string;
  availableModels: AiModelOptionDto[];
  modelInput: string;
  loading: boolean;
  onLoad: () => void;
  onToggle: (modelId: string) => void;
  onModelInputChange: (value: string) => void;
  onAddManual: () => void;
  onPrimaryChange: (value: string) => void;
  onUtilityChange: (value: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[13px] font-medium">启用模型</div>
          <div className="mt-1 text-[11.5px] text-[var(--color-fg-3)]">
            当前 {enabledModels.length} 个
          </div>
        </div>
        <Button type="button" size="sm" onClick={onLoad} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} />
          ) : (
            <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
          )}
          获取模型列表
        </Button>
      </div>

      <div className="flex min-h-9 flex-wrap gap-2">
        {enabledModels.length === 0 ? (
          <span className="text-[12px] text-[var(--color-fg-3)]">
            暂无启用模型，可手动添加或从服务获取。
          </span>
        ) : (
          enabledModels.map((model) => (
            <span
              key={model}
              className="inline-flex min-h-8 items-center gap-1 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface-hover)] pl-2.5 pr-1 font-mono text-[11.5px]"
            >
              {model}
              <button
                type="button"
                onClick={() => onToggle(model)}
                className="grid h-7 w-7 place-items-center rounded-[5px] text-[var(--color-fg-3)] hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]"
                aria-label={`停用模型 ${model}`}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <InputShell className="flex-1">
          <Input
            value={modelInput}
            onChange={(event) => onModelInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onAddManual();
            }}
            placeholder="输入 model id"
            aria-label="手动输入模型 ID"
          />
        </InputShell>
        <Button type="button" onClick={onAddManual}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          添加模型
        </Button>
      </div>

      {availableModels.length > 0 && (
        <div className="max-h-60 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
          {availableModels.map((model) => {
            const checked = enabledModels.includes(model.id);
            return (
              <label
                key={model.id}
                className="flex min-h-10 cursor-pointer items-center gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 text-[12.5px] last:border-b-0 hover:bg-[var(--color-surface-hover)]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(model.id)}
                  className="h-4 w-4 accent-[var(--color-fg)]"
                />
                <span className="truncate font-mono">{model.id}</span>
              </label>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <ModelField
          label="Primary 主模型"
          hint="用于报告生成、推理和证据处理。"
        >
          <Select
            value={primaryModel || '__auto'}
            onValueChange={(value) =>
              onPrimaryChange(value === '__auto' ? '' : value)
            }
            className="w-full"
            ariaLabel="Primary 主模型"
          >
            <SelectOption value="__auto">自动使用启用列表第一项</SelectOption>
            {enabledModels.map((model) => (
              <SelectOption key={model} value={model}>
                {model}
              </SelectOption>
            ))}
          </Select>
        </ModelField>
        <ModelField
          label="Utility 辅助模型"
          hint="用于结构化抽取、修复和摘要任务。"
        >
          <Select
            value={utilityModel || '__none'}
            onValueChange={(value) =>
              onUtilityChange(value === '__none' ? '' : value)
            }
            className="w-full"
            ariaLabel="Utility 辅助模型"
          >
            <SelectOption value="__none">不设置，使用 Primary</SelectOption>
            {enabledModels.map((model) => (
              <SelectOption key={model} value={model}>
                {model}
              </SelectOption>
            ))}
          </Select>
        </ModelField>
      </div>
    </>
  );
}

function ModelField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-[var(--color-fg-2)]">
        {label}
      </div>
      {children}
      <p className="mt-1.5 text-[11.5px] leading-[1.5] text-[var(--color-fg-3)]">
        {hint}
      </p>
    </div>
  );
}
