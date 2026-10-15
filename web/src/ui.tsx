import { ReactNode, useRef, useState, useSyncExternalStore } from 'react';
import { pendingWrites } from './api';
import { t } from './i18n';

export const Spinner = ({ className = 'size-3.5' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={`${className} shrink-0 motion-safe:animate-spin`} fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Pending shows a spinner next to a label while an action runs.
// Lucide-style 16px stroke icons, inlined so the UI needs no icon package.
export const icons = {
  bold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  italic: 'M19 4h-9M14 20H5M15 4 9 20',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  quote: 'M17 6H3M21 12H8M21 18H8M3 12v6',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
  ul: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  ol: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  image: 'M21 15l-5-5L5 21M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 9h.01',
  sparkle:
    'M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0zM20 3v4M22 5h-4',
  sliders: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  plus: 'M5 12h14M12 5v14',
  left: 'm15 18-6-6 6-6',
  right: 'm9 18 6-6-6-6',
  columns: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18M15 3v18',
  sort: 'm21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  reset: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
};

export const Icon = ({ d, size = 'size-4' }: { d: string; size?: string }) => (
  <svg viewBox="0 0 24 24" className={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

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

type Confirm = { title: string; text?: string; action: string; danger?: boolean };

// useConfirm replaces window.confirm with a modal: `if (await ask({...}))` goes on when the user confirms.
// Render the returned dialog once in the component.
export function useConfirm() {
  const ref = useRef<HTMLDialogElement>(null);
  const answer = useRef<(ok: boolean) => void>(() => {});
  const [opts, setOpts] = useState<Confirm | null>(null);
  const ask = (o: Confirm) =>
    new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setOpts(o);
      ref.current?.showModal();
    });
  const close = (ok: boolean) => {
    answer.current(ok);
    ref.current?.close();
  };
  const dialog = (
    // Escape closes it too, as a cancel: the second answer of a promise is ignored.
    <dialog ref={ref} onClose={() => answer.current(false)} className="panel m-auto w-[calc(100%-2rem)] max-w-sm p-0 text-ink shadow-xl backdrop:bg-ink/30">
      {opts && (
        <div className="flex flex-col gap-4 p-6">
          <h2>{opts.title}</h2>
          {opts.text && <p className="text-[13px] text-muted">{opts.text}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" autoFocus onClick={() => close(false)}>
              {t('Cancel')}
            </button>
            <button type="button" className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
              {opts.action}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
  return [ask, dialog] as const;
}
