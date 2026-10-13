import { ReactNode, useState, useSyncExternalStore } from 'react';
import { pendingWrites } from './api';
import { t } from './i18n';

export const Spinner = ({ className = 'size-3.5' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={`${className} shrink-0 motion-safe:animate-spin`} fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Pending shows a spinner next to a label while an action runs.
export const Pending = ({ on, children }: { on: boolean; children: ReactNode }) => (
  <>
    {on && <Spinner />}
    {children}
  </>
);

// ProgressBar runs across the top of the screen while any write is in flight.
export function ProgressBar() {
  const n = useSyncExternalStore(pendingWrites.subscribe, pendingWrites.get);
  if (!n) return null;
  return (
    <div role="progressbar" aria-label={t('Saving')} className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-accent/15">
      <div className="progress-bar h-full w-2/5 bg-accent" />
    </div>
  );
}

// useAction runs one async action at a time and tells which one is running, to disable buttons and show spinners.
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };
  return [run, pending] as const;
}
