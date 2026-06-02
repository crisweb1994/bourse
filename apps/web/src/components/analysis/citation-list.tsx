'use client';

/**
 * Citation list — Style A.
 *
 * Horizontal-scroll row of 260px cards, shown inside each section.
 * Mockup: docs/mockups/citation-card-variants.html · V2.
 */
import { useMemo } from 'react';
import type { AnalysisCitation } from '@/hooks/use-analysis-stream';
import { Card, SectionTag } from '@/components/ui';
import { cn } from '@/lib/utils';

export function CitationList({
  citations,
  className,
}: {
  citations: AnalysisCitation[];
  className?: string;
}) {
  const unique = useMemo(
    () =>
      citations.filter(
        (c, i, arr) => arr.findIndex((x) => x.url === c.url) === i,
      ),
    [citations],
  );

  if (unique.length === 0) return null;

  return (
    <Card className={className}>
      <div className="px-5 py-3 border-b border-[var(--color-border-soft)]">
        <SectionTag>引用来源 · {unique.length}</SectionTag>
      </div>
      <div
        className={cn(
          'flex gap-2.5 overflow-x-auto px-5 py-4',
          // Tighter scrollbar so a horizontal strip doesn't feel heavy.
          '[&::-webkit-scrollbar]:h-2',
          '[&::-webkit-scrollbar-thumb]:bg-[var(--color-fg-4)]',
          '[&::-webkit-scrollbar-thumb]:rounded-full',
        )}
        style={{ scrollSnapType: 'x proximity' }}
      >
        {unique.map((c, i) => (
          <CitationCard key={i} index={i + 1} citation={c} />
        ))}
      </div>
    </Card>
  );
}

function CitationCard({
  index,
  citation,
}: {
  index: number;
  citation: AnalysisCitation;
}) {
  const host = useMemo(() => {
    try {
      return new URL(citation.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }, [citation.url]);

  const display = citation.title || citation.url || host || '(untitled)';

  return (
    <a
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex w-[260px] shrink-0 flex-col gap-2 rounded-[var(--radius-card)] ' +
          'border border-[var(--color-border)] bg-[var(--color-bg-elev)] ' +
          'px-3.5 py-3 transition-colors duration-100 ' +
          'hover:border-[var(--color-fg-4)]',
      )}
      style={{ scrollSnapAlign: 'start' }}
      title={display}
    >
      {/* Title row — index on the left, title to the right (top-aligned). */}
      <div className="flex min-h-[38px] items-start gap-2">
        <span
          className={
            'shrink-0 pt-[1px] font-mono text-[10.5px] leading-[1.4] ' +
            'tracking-[0.04em] text-[var(--color-fg-3)]'
          }
        >
          [{index}]
        </span>
        <span
          className="line-clamp-2 flex-1 min-w-0 text-[13px] leading-[1.45] text-[var(--color-fg)]"
        >
          {display}
        </span>
      </div>

      {/* Source row — favicon + host pinned to card bottom. */}
      <div className="mt-auto inline-flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-2)]">
        <SourceFavicon host={host} />
        <span className="truncate">{host || '—'}</span>
        {citation.searchAdapter && (
          <span
            className={
              'ml-auto shrink-0 rounded-[3px] border border-[var(--color-border-soft)] ' +
              'bg-[var(--color-surface-2)] px-1 py-[1px] text-[9.5px] ' +
              'text-[var(--color-fg-3)] tracking-[0.04em]'
            }
            title={`source adapter: ${citation.searchAdapter}`}
          >
            {citation.searchAdapter}
          </span>
        )}
      </div>
    </a>
  );
}

// Lightweight favicon — round badge with the first letter of the host.
// Real <img src="…/favicon.ico"> is fragile across mixed-origin sources
// (CSP, cache, fallback handling). The badge stays consistent with Style A.
function SourceFavicon({ host }: { host: string }) {
  const letter = (host?.[0] ?? '?').toUpperCase();
  // Domain → deterministic colour family. Stays in Style A's restrained
  // palette (deep accent, fg, warm gray).
  const tone = useMemo(() => {
    if (!host) return 'bg-[var(--color-fg-3)]';
    const knownTones: Record<string, string> = {
      'sec.gov': 'bg-[#0b3d91]',
      'apple.com': 'bg-[var(--color-fg)]',
      'bloomberg.com': 'bg-[#1f1f1f]',
      'reuters.com': 'bg-[#ff6a00]',
      'macrotrends.net': 'bg-[#2563eb]',
      'nasdaq.com': 'bg-[#0a8aff]',
      'statista.com': 'bg-[#1e3a8a]',
      'ycharts.com': 'bg-[var(--color-accent)]',
    };
    return knownTones[host] ?? 'bg-[var(--color-accent-600)]';
  }, [host]);
  return (
    <span
      aria-hidden
      className={cn(
        'grid h-[14px] w-[14px] place-items-center rounded-full text-[8px] font-semibold text-white',
        tone,
      )}
    >
      {letter}
    </span>
  );
}
