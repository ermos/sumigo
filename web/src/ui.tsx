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
