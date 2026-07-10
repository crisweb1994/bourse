/**
 * Comprehensive workflow 的 async helpers — 从 streamComprehensive 抽出的
 * 异步 IO + 解析链。与 comprehensive-helpers.ts (同步纯函数) 分文件存放，
 * 保持 helpers 文件"无 IO、可同步单测"的边界。
 *
 * 这两个函数都不 yield；generator 主流程负责把它们的返回值转成 SSE。
 */
import type { Citation } from '../contracts/citation';
import type { EvidencePackAny } from '../contracts/evidence-pack';
import { applyFixedDisclaimerToSummary } from '../primitives/disclaimer';
import { buildEvidencePack } from '../primitives/evidence-pack-builder';
import { computeUsd } from '../primitives/pricing';
import {
  ComprehensiveSummaryLenient,
  buildSummaryJsonPrompts,
  hydrateSummaryCitations,
} from '../primitives/summary-prompts';
import { structuredOutputWithRepair } from '../primitives/structured-output';
import { inferMissingPrivateFieldsComp } from './comprehensive-helpers';
import type { AgentProvider } from '../primitives/provider';
import type { DimensionInput } from './types';

/**
 * A v2 pack is "critically degraded" when its `dataAvailability.complete`
 * list contains neither `quote` nor `financials` — i.e. there is no
 * structured data worth analyzing. Partial degradation (quote present,
 * financials missing) is NOT critical: the v2 pack is kept and per-dim
 * gap-fill handles the missing fields.
 */
export function isPackCriticallyDegraded(pack: EvidencePackAny): boolean {
  const complete = (pack as { dataAvailability?: { complete?: unknown } })
    .dataAvailability?.complete;
  if (!Array.isArray(complete)) return false;
  return !complete.includes('quote') && !complete.includes('financials');
}

/**
 * No-usable-data recovery: when the structured fetch produced nothing worth
 * keeping (no pack, or a critically-degraded pack), rebuild via the v1 LLM
 * web_search builder so the run yields a result instead of failing empty.
 *
 * The rebuilt pack is stamped `degradedSource: WEB_SEARCH_FALLBACK`, so its
 * web-sourced numbers are clearly marked non-authoritative (never fed to
 * compute as code-verified — hard invariant #1) and private-data dims skip.
 *
 * Returns the rebuilt pack, or the existing pack when it is healthy or
 * recovery is disabled.
 */
export async function resolveEvidencePack(
  provider: AgentProvider,
  input: DimensionInput,
  init: {
    evidencePack: EvidencePackAny | undefined;
    recoverMissingEvidence: boolean;
    todayDate?: string;
    signal?: AbortSignal;
  },
): Promise<EvidencePackAny | undefined> {
  if (
    !init.recoverMissingEvidence ||
    (init.evidencePack && !isPackCriticallyDegraded(init.evidencePack))
  ) {
    return init.evidencePack;
  }
  const v1 = await buildEvidencePack(provider, input, {
    ...(init.todayDate ? { todayDate: init.todayDate } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return {
    ...v1,
    dataAvailability: {
      degradedSource: 'WEB_SEARCH_FALLBACK' as const,
      fallbackReason: {
        kind: 'OTHER',
        failedTools: [],
        message: 'no usable structured data (neither quote nor financials)',
      },
      missingPrivateFields: inferMissingPrivateFieldsComp([]),
    },
  };
}

/**
 * Parse the summary markdown into a validated, citation-hydrated,
 * disclaimer-fixed ComprehensiveSummary object, plus a trace delta the
 * caller folds into its aggregated counters.
 *
 * Wraps the structuredOutputWithRepair → hydrateSummaryCitations →
 * applyFixedDisclaimerToSummary chain (formerly inline at the end of
 * streamComprehensive's summary phase).
 */
export async function parseSummaryStructured(
  provider: AgentProvider,
  summaryMarkdown: string,
  allCitations: Citation[],
  todayDate: string,
  signal?: AbortSignal,
): Promise<{
  fixedSummary: ReturnType<typeof applyFixedDisclaimerToSummary>;
  trace: { tokensIn: number; tokensOut: number; llmCalls: number; costUsd: number };
}> {
  const jsonPrompts = buildSummaryJsonPrompts(summaryMarkdown);
  const summaryStructured = await structuredOutputWithRepair(
    provider,
    jsonPrompts.system,
    jsonPrompts.user,
    ComprehensiveSummaryLenient,
    { signal },
  );
  const strictSummary = hydrateSummaryCitations(
    summaryStructured.data,
    allCitations,
    todayDate,
  );
  const fixedSummary = applyFixedDisclaimerToSummary(strictSummary);
  return {
    fixedSummary,
    trace: {
      tokensIn: summaryStructured.usage.tokensIn,
      tokensOut: summaryStructured.usage.tokensOut,
      llmCalls: summaryStructured.llmCalls,
      costUsd: computeUsd(
        summaryStructured.model,
        summaryStructured.usage.tokensIn,
        summaryStructured.usage.tokensOut,
      ),
    },
  };
}
