'use client';

import { useEffect, useState } from 'react';
import type { ActiveAnalysisType } from '@bourse/shared-types';
import {
  listAiProviderSettings,
  type AiProviderSettingDto,
} from '@/lib/api';

export function useAnalysisLauncherState(
  initialType: ActiveAnalysisType = 'FUNDAMENTAL',
) {
  const [selectedType, setSelectedType] = useState(initialType);
  const [selectedSettingId, setSelectedSettingId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [providerSettings, setProviderSettings] = useState<
    AiProviderSettingDto[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    listAiProviderSettings()
      .then((items) => {
        if (cancelled) return;
        const enabled = items.filter((s) => s.enabled);
        setProviderSettings(enabled);
        const def = enabled.find((s) => s.isDefault) ?? enabled[0];
        if (def) {
          setSelectedSettingId(def.id);
          setSelectedModel(def.enabledModels[0] ?? '');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    selectedType,
    setSelectedType,
    selectedSettingId,
    setSelectedSettingId,
    selectedModel,
    setSelectedModel,
    providerSettings,
  };
}
