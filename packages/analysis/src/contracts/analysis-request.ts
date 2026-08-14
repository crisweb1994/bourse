import { z } from 'zod';
import { AnalysisMode, FocusWindow } from './enums';

export const AnalysisRequest = z.object({
  symbol: z.string().min(1),
  market: z.string().min(1),
  mode: AnalysisMode,
  focusWindow: FocusWindow.default('90D'),
  locale: z.string().min(2).default('zh-CN'),
  question: z.string().trim().min(1).max(500).optional(),
});
export type AnalysisRequest = z.infer<typeof AnalysisRequest>;
