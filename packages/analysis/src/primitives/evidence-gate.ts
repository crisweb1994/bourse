import type { SectionResult } from '../contracts/analysis-result';
import type { CitationQualityTier } from '../contracts/citation';
import type { DomainTier } from '../markets/types';

export interface EvidenceGateResult {
  data: SectionResult;
  warnings: string[];
  noEvidence: boolean;
}

export interface EvidenceGateOptions {
  domainTiers?: Record<string, DomainTier>;
}

const RANK: Record<CitationQualityTier, number> = {
  A: 0,
  B: 1,
  C: 2,
  D: 3,
  E: 4,
};

export function inferDomainTier(
  url: string,
  domainTiers: Record<string, DomainTier> | undefined,
): DomainTier | null {
  if (!domainTiers) return null;
  try {
    let host = new URL(url).hostname.replace(/^www\./, '');
    while (host.includes('.')) {
      if (domainTiers[host]) return domainTiers[host];
      host = host.slice(host.indexOf('.') + 1);
    }
  } catch {
    return null;
  }
  return null;
}

export function applyEvidenceGate(
  data: SectionResult,
  options: EvidenceGateOptions = {},
): EvidenceGateResult {
  const warnings: string[] = [];
  const mapCitation = (citation: SectionResult['findings'][number]['evidence'][number]['citations'][number]) => {
    if (!citation.qualityTier) return citation;
    const tier = inferDomainTier(citation.url, options.domainTiers);
    if (!tier || RANK[citation.qualityTier] >= RANK[tier]) return citation;
    warnings.push(`来源等级按域名降级：${citation.url}`);
    return { ...citation, qualityTier: tier as CitationQualityTier };
  };
  const result: SectionResult = {
    ...data,
    findings: data.findings.map((finding) => ({
      ...finding,
      evidence: finding.evidence.map((evidence) => ({
        ...evidence,
        citations: evidence.citations.map(mapCitation),
      })),
    })),
  };
  const claimCount = result.findings.reduce(
    (count, finding) => count + finding.evidence.length,
    0,
  );
  return { data: result, warnings, noEvidence: claimCount === 0 };
}
