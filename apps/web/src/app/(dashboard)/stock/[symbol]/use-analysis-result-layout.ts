'use client';

import { useMemo, useRef, useState } from 'react';
import type { NavItem } from '@/components/analysis/left-section-nav';
import { useScrollSpy } from '@/hooks/use-scroll-spy';
import type { AnalysisStreamState, SectionData } from '@/hooks/use-analysis-stream';
import { SECTION_LABELS, SECTION_TYPES } from '@/lib/constants';
import type { SectionStatus, SectionType } from '@bourse/shared-types';

interface InitialSection {
  id?: string;
  type: SectionType;
  order?: number;
  status: SectionStatus | string;
  reportMarkdown?: string | null;
  structuredJson?: unknown;
}

function toUiStatus(status: string): SectionData['status'] {
  switch (status) {
    case 'IN_PROGRESS': return 'streaming';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'SKIPPED': return 'skipped';
    case 'CANCELLED': return 'cancelled';
    default: return 'pending';
  }
}

function placeholder(type: SectionType, order: number): SectionData {
  return {
    type,
    order,
    status: 'pending',
    markdown: '',
    structuredJson: null,
    citations: [],
  };
}

export function useAnalysisResultLayout({
  stream,
  initialSections = [],
}: {
  stream: Pick<AnalysisStreamState, 'sections' | 'summaryMarkdown' | 'summaryJson'>;
  initialSections?: readonly InitialSection[];
}) {
  const [manualActive, setManualActive] = useState<string | null>(null);
  const lockUntilRef = useRef(0);
  const sectionList = useMemo(() => {
    const initialByType = new Map(
      initialSections.map((section, index) => [section.type, {
        id: section.id,
        type: section.type,
        order: section.order ?? index,
        status: toUiStatus(section.status),
        markdown: section.reportMarkdown ?? '',
        structuredJson: section.structuredJson ?? null,
        citations: [],
      } satisfies SectionData]),
    );
    return SECTION_TYPES.map((type, order) =>
      stream.sections[type] ?? initialByType.get(type) ?? placeholder(type, order),
    ).sort((a, b) => a.order - b.order);
  }, [initialSections, stream.sections]);
  const scrollIds = useMemo(() => [...sectionList.map((section) => `section-${section.type}`), ...(stream.summaryMarkdown ? ['section-SUMMARY'] : [])], [sectionList, stream.summaryMarkdown]);
  const spiedActiveId = useScrollSpy(scrollIds);
  const effectiveActive = Date.now() < lockUntilRef.current ? manualActive : (spiedActiveId ?? (sectionList[0] ? `section-${sectionList[0].type}` : null));
  const handleNavClick = (id: string) => {
    setManualActive(id);
    lockUntilRef.current = Date.now() + 1500;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const navItems = useMemo<NavItem[]>(() => {
    const sectionByType = new Map(sectionList.map((section) => [section.type, section]));
    const items = SECTION_TYPES.map((type) => ({
      id: `section-${type}`,
      label: SECTION_LABELS[type],
      status: sectionByType.get(type)?.status ?? 'pending',
    }));
    if (stream.summaryMarkdown) items.push({ id: 'section-SUMMARY', label: '综合结论', status: 'completed' });
    return items;
  }, [sectionList, stream.summaryMarkdown]);
  return {
    sectionList,
    isMultiSection: true,
    navItems,
    effectiveActive,
    rightInsightsSummary: null,
    hasRightPanel: false,
    failedSections: sectionList.filter((section) => section.status === 'failed' || section.status === 'skipped'),
    handleNavClick,
  };
}
