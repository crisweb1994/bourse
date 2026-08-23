import { Suspense } from 'react';
import { DiscoverWorkspace } from './discover-workspace';

export default function DiscoverPage() {
  return (
    <Suspense fallback={<DiscoverPageFallback />}>
      <DiscoverWorkspace />
    </Suspense>
  );
}

function DiscoverPageFallback() {
  return (
    <div className="animate-pulse">
      <div className="h-3 w-36 bg-[var(--color-surface-2)]" />
      <div className="mt-4 h-8 w-44 bg-[var(--color-surface-2)]" />
      <div className="mt-3 h-4 max-w-[620px] bg-[var(--color-surface-2)]" />
      <div className="mt-10 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="h-[560px] border border-[var(--color-border)] bg-[var(--color-bg-elev)]" />
        <div className="h-[560px] border border-[var(--color-border)] bg-[var(--color-bg-elev)]" />
      </div>
    </div>
  );
}
