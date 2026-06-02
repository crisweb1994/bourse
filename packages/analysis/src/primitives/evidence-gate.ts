import type { StructuredJson } from '../contracts/analysis-result';
import type { Citation, CitationQualityTier } from '../contracts/citation';
import type { DomainTier } from '../markets/types';

/**
 * MVP doc §4.3.4 + RFC-06 — A-E citation quality gate. Returns the gated
 * structuredJson plus a list of warnings describing what was changed/flagged.
 *
 * Four rules, applied in order:
 *   0. **RFC-06 domain-tier downgrade**: when caller passes `domainTiers`
 *      (typically `marketProfile.domainTiers` for CN), any citation whose
 *      LLM-declared `qualityTier` is HIGHER than the code-side tier inferred
 *      from the host is force-downgraded to the code-side tier (with a
 *      warning). Citations whose host is absent from `domainTiers` are
 *      left untouched (no code-side ground truth → don't override the LLM).
 *      Citations without `qualityTier` are also untouched here (Rule 1
 *      still treats missing tier as E for removal).
 *   1. **E-only claim removal**: any evidence claim whose citations are all
 *      tier E (missing tier counted as E) is removed from `evidence[]`.
 *      Warning written for each removed claim. If `evidence` ends up empty
 *      and at least one claim was removed, a `noEvidence` flag is returned
 *      so callers can trigger dim retry.
 *   2. **AB soft check**: if `conclusion.signal === 'BULLISH'` and AB-tier
 *      citation ratio < 50%, write soft warning. No mutation.
 *   3. **AB hard check**: if `signal === 'BULLISH'` AND `recommendation
 *      === 'BUY'` AND AB ratio < 30%, force `conclusion.confidence` to
 *      MEDIUM when it was HIGH. Mutation + warning.
 *
 * Gate runs BEFORE `applyFixedDisclaimer` so callers see a single mutation
 * pipeline.
 */
export interface EvidenceGateResult {
  data: StructuredJson;
  warnings: string[];
  /** True when E-only removal emptied the evidence array. */
  noEvidence: boolean;
}

export interface EvidenceGateOptions {
  /**
   * RFC-06: code-side ground-truth domain → tier table (from a market
   * profile's `domainTiers`). When set, the gate force-downgrades any
   * citation whose LLM-declared `qualityTier` exceeds the inferred
   * code-side tier. Undefined → skip the rule (legacy behavior).
   */
  domainTiers?: Record<string, DomainTier>;
  /**
   * RFC financials Phase 1 — fact keys the caller asserts the dim MUST
   * reference in `structuredJson.factReferences[]`. When the dim output
   * is missing any of these keys, the gate emits a warning (not a hard
   * reject — output stays useful, but trace surfaces the contract miss).
   *
   * Caller is responsible for deciding when to populate this; typically
   * stream-dimension sets `['financials']` for FUNDAMENTAL/VALUATION
   * dims when the EvidencePack carries `facts.financials`.
   */
  requiredFactReferences?: readonly string[];
}

const AB_SOFT_THRESHOLD = 0.5;
const AB_HARD_THRESHOLD = 0.3;

const TIER_RANK: Record<DomainTier, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

/**
 * RFC-06: resolve a citation URL to its code-side `DomainTier`. Tries the
 * exact hostname first, then walks parent domains (e.g.
 * `static.cninfo.com.cn` → `cninfo.com.cn`). Returns null when the URL is
 * malformed or no parent domain is in the table.
 *
 * Exported for unit-testing; production callers should go through
 * `applyEvidenceGate`.
 */
export function inferDomainTier(
  url: string,
  domainTiers: Record<string, DomainTier> | undefined,
): DomainTier | null {
  if (!domainTiers) return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (domainTiers[host]) return domainTiers[host];
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (domainTiers[parent]) return domainTiers[parent];
  }
  return null;
}

export function applyEvidenceGate(
  data: StructuredJson,
  options: EvidenceGateOptions = {},
): EvidenceGateResult {
  const warnings: string[] = [];

  // Rule 0 (RFC-06): force-downgrade any LLM-declared qualityTier that
  // exceeds the code-side tier inferred from the citation host. We rebuild
  // the evidence array on a fresh object so subsequent rules (E-only
  // removal, AB ratios) see the corrected tiers.
  const tieredEvidence = data.evidence.map((ev) => ({
    claim: ev.claim,
    citations: ev.citations.map((c) => {
      if (!c.qualityTier) return c; // backward compat: skip untiered
      const codeTier = inferDomainTier(c.url, options.domainTiers);
      if (codeTier === null) return c; // unknown host: trust LLM
      if (TIER_RANK[c.qualityTier] < TIER_RANK[codeTier]) {
        warnings.push(
          `Citation ${c.url}: LLM declared ${c.qualityTier}, code-side ${codeTier} — downgraded`,
        );
        return { ...c, qualityTier: codeTier as CitationQualityTier };
      }
      return c;
    }),
  }));
  const tieredData: StructuredJson = {
    ...data,
    evidence: tieredEvidence,
  };

  // Rule 1: E-only claim removal
  const keptEvidence: typeof tieredData.evidence = [];
  let removedClaims = 0;
  for (const ev of tieredData.evidence) {
    const allE = ev.citations.length === 0
      ? false // empty citations is a different problem (handled by minPerClaim)
      : ev.citations.every((c) => tierOf(c) === 'E');
    if (allE) {
      removedClaims++;
      warnings.push(
        `E-only claim removed: "${ev.claim}" (${ev.citations.length} citation(s), all tier E)`,
      );
    } else {
      keptEvidence.push(ev);
    }
  }

  const gated: StructuredJson = {
    ...tieredData,
    evidence: keptEvidence,
  };

  const noEvidence = removedClaims > 0 && keptEvidence.length === 0;

  // Rules 2-3 operate on AB-tier ratio across REMAINING citations.
  const allCitations: Citation[] = [];
  for (const ev of keptEvidence) {
    for (const c of ev.citations) allCitations.push(c);
  }
  const abRatio = allCitations.length === 0
    ? 0
    : allCitations.filter((c) => {
        const t = tierOf(c);
        return t === 'A' || t === 'B';
      }).length / allCitations.length;

  const signal = gated.conclusion.signal;
  const recommendation = gated.recommendation;

  // Rule 2: AB soft check
  if (signal === 'BULLISH' && allCitations.length > 0 && abRatio < AB_SOFT_THRESHOLD) {
    warnings.push(
      `BULLISH 结论的 A/B 级证据占比偏低（${(abRatio * 100).toFixed(0)}%），建议下调 confidence`,
    );
  }

  // Rule 3: AB hard check — downgrade confidence
  if (
    signal === 'BULLISH' &&
    recommendation === 'BUY' &&
    allCitations.length > 0 &&
    abRatio < AB_HARD_THRESHOLD &&
    gated.conclusion.confidence === 'HIGH'
  ) {
    warnings.push(
      `BULLISH+BUY 且 A/B 级证据占比 < 30%（实际 ${(abRatio * 100).toFixed(0)}%）— confidence 强制从 HIGH 降为 MEDIUM`,
    );
    gated.conclusion = {
      ...gated.conclusion,
      confidence: 'MEDIUM',
    };
  }

  // Rule 4 (RFC financials Phase 1): required fact references soft check.
  // When the caller asserts certain fact keys must appear in
  // `structuredJson.factReferences[]`, warn for each missing key. No
  // mutation — the dim output is still surfaced, but trace records the
  // contract violation so the orchestrator / eval can flag it.
  if (options.requiredFactReferences && options.requiredFactReferences.length > 0) {
    const declared = new Set(gated.factReferences ?? []);
    for (const key of options.requiredFactReferences) {
      if (!declared.has(key)) {
        warnings.push(
          `factReferences missing required key "${key}" — pack carried this fact but the dim did not declare it (RFC financials §3.8)`,
        );
      }
    }
  }

  return { data: gated, warnings, noEvidence };
}

/** Citation without explicit qualityTier is treated as tier E. */
function tierOf(c: Citation): 'A' | 'B' | 'C' | 'D' | 'E' {
  return c.qualityTier ?? 'E';
}
