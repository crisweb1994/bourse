import { Injectable } from '@nestjs/common';
import { selectRelevantFilingSections, type FilingSection } from '@bourse/analysis';
import { EarningsCardPayloadSchema } from '@bourse/analysis';
import { PrismaService } from '../prisma/prisma.service';

export interface EarningsSectionSource {
  title: string;
  text: string;
  sourceUrl: string;
  provider: string;
  filingId: string;
  derivationId: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
  pageStart?: number;
  pageEnd?: number;
}

@Injectable()
export class EarningsSectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async retrieve(revisionId: string, question: string): Promise<EarningsSectionSource[]> {
    const revision = await this.prisma.earningsCardRevision.findUnique({ where: { id: revisionId } });
    if (!revision) return [];
    const parsed = EarningsCardPayloadSchema.safeParse(revision.payload);
    if (!parsed.success) return [];
    const filingIds = [parsed.data.filing, ...parsed.data.supportingFilings]
      .flatMap((filing) => filing.filingId ? [filing.filingId] : []);
    if (filingIds.length === 0) return [];
    const derivations = await this.prisma.filingDerivation.findMany({
      where: { filingId: { in: filingIds }, status: 'COMPLETE' },
      orderBy: { createdAt: 'desc' },
      include: { filing: true },
    });
    const latestByFiling = new Map<string, typeof derivations[number]>();
    for (const derivation of derivations) {
      if (!latestByFiling.has(derivation.filingId)) latestByFiling.set(derivation.filingId, derivation);
    }
    return [...latestByFiling.values()].flatMap((derivation) => {
      const sections = parseSections(derivation.sections);
      return selectRelevantFilingSections(sections, question, 3).map((section) => ({
        title: section.title,
        text: section.text.slice(0, 12_000),
        sourceUrl: derivation.filing.sourceUrl,
        provider: derivation.filing.provider,
        filingId: derivation.filingId,
        derivationId: derivation.id,
        contentHash: derivation.contentHash,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
      }));
    });
  }
}

function parseSections(value: unknown): FilingSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return [];
    const item = section as Record<string, unknown>;
    if (
      typeof item.id !== 'string'
      || typeof item.title !== 'string'
      || typeof item.text !== 'string'
      || typeof item.startOffset !== 'number'
      || typeof item.endOffset !== 'number'
    ) return [];
    return [{
      id: item.id,
      title: item.title,
      text: item.text,
      startOffset: item.startOffset,
      endOffset: item.endOffset,
      ...(typeof item.pageStart === 'number' ? { pageStart: item.pageStart } : {}),
      ...(typeof item.pageEnd === 'number' ? { pageEnd: item.pageEnd } : {}),
    }];
  });
}
