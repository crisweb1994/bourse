'use client';

import { useEffect, useState } from 'react';
import type { AnalysisMode, FocusWindow } from '@bourse/shared-types';
import { listAiProviderSettings, type AiProviderSettingDto } from '@/lib/api';

export function useAnalysisLauncherState() {
  const [selectedMode, setSelectedMode] = useState<AnalysisMode>('QUICK');
  const [selectedFocusWindow, setSelectedFocusWindow] = useState<FocusWindow>('90D');
  const [selectedSettingId, setSelectedSettingId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [question, setQuestion] = useState('');
  const [providerSettings, setProviderSettings] = useState<AiProviderSettingDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    listAiProviderSettings()
      .then((items) => {
        if (cancelled) return;
        const enabled = items.filter((setting) => setting.enabled);
        setProviderSettings(enabled);
        const defaultSetting = enabled.find((setting) => setting.isDefault) ?? enabled[0];
        if (defaultSetting) {
          setSelectedSettingId(defaultSetting.id);
          setSelectedModel(defaultSetting.enabledModels[0] ?? '');
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return {
    selectedMode,
    setSelectedMode,
    selectedFocusWindow,
    setSelectedFocusWindow,
    selectedSettingId,
    setSelectedSettingId,
    selectedModel,
    setSelectedModel,
    question,
    setQuestion,
    providerSettings,
  };
}
