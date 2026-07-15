'use client';

import { useMemo, useRef, useState } from 'react';
import type { NavItem } from '@/components/analysis/left-section-nav';
import { useScrollSpy } from '@/hooks/use-scroll-spy';
import type { AnalysisStreamState } from '@/hooks/use-analysis-stream';
import {
  ANALYSIS_DIMENSIONS,
  ANALYSIS_TYPE_LABELS as SECTION_LABELS,
} from '@/lib/constants';
import {
  buildRightInsightsSummary,
} from './stock-page-ui';

const COMPREHENSIVE_SECTION_TYPES = ANALYSIS_DIMENSIONS;

export function useAnalysisResultLayout({
  stream,
  analysisType,
}: {
  stream: Pick<
    AnalysisStreamState,
    'sections' | 'summaryMarkdown' | 'summaryJson'
  >;
  analysisType?: string | null;
}) {
  const [manualActive, setManualActive] = useState<string | null>(null);
  const lockUntilRef = useRef(0);

  const sectionList = useMemo(
    () => Object.values(stream.sections).sort((a, b) => a.order - b.order),
    [stream.sections],
  );

  const isComprehensiveRun =
    analysisType === 'COMPREHENSIVE' ||
    sectionList.length > 1 ||
    !!stream.summaryMarkdown;
  const isMultiSection =
    sectionList.length > 1 || (isComprehensiveRun && sectionList.length > 0);

  const scrollIds = useMemo(() => {
    const ids = sectionList.map((section) => `section-${section.type}`);
    if (stream.summaryMarkdown) ids.push('section-SUMMARY');
    return ids;
  }, [sectionList, stream.summaryMarkdown]);

  const spiedActiveId = useScrollSpy(scrollIds);

  const effectiveActive =
    Date.now() < lockUntilRef.current
      ? manualActive
      : (spiedActiveId ??
        (sectionList[0] ? `section-${sectionList[0].type}` : null));

  const handleNavClick = (id: string) => {
    setManualActive(id);
    lockUntilRef.current = Date.now() + 1500;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const navItems = useMemo<NavItem[]>(() => {
    const sectionByType = new Map(
      sectionList.map((section) => [section.type, section]),
    );
    const navTypes = isComprehensiveRun
      ? COMPREHENSIVE_SECTION_TYPES
      : sectionList.map((section) => section.type);

    const items: NavItem[] = navTypes.map((type) => {
      const section = sectionByType.get(type);
      return {
        id: `section-${type}`,
        label: SECTION_LABELS[type] || type,
        status: section?.status ?? 'pending',
      };
    });
    if (stream.summaryMarkdown) {
      items.push({
        id: 'section-SUMMARY',
        label: '综合总览',
        status: 'completed',
        isSummary: true,
      });
    }
    return items;
  }, [isComprehensiveRun, sectionList, stream.summaryMarkdown]);

  const rightInsightsSummary = useMemo(
    () => buildRightInsightsSummary(stream.summaryJson, sectionList),
    [sectionList, stream.summaryJson],
  );
  const hasRightPanel = isMultiSection && !!rightInsightsSummary;

  const failedSections = useMemo(
    () => sectionList.filter((section) => section.status === 'failed'),
    [sectionList],
  );

  return {
    sectionList,
    isMultiSection,
    navItems,
    effectiveActive,
    rightInsightsSummary,
    hasRightPanel,
    failedSections,
    handleNavClick,
  };
}
