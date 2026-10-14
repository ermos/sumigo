import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { basicSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { Diagnostic, linter } from '@codemirror/lint';
import { api, HttpError } from './api';
import { useCtx } from './App';
import { Loading, Notice, PageHeader } from './Site';
import { Pending } from './ui';
import { suggest } from './yamlcomplete';
import { t } from './i18n';

function complete(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const s = suggest(ctx.state.doc.sliceString(0, line.from), line.text.slice(0, ctx.pos - line.from), ctx.state.doc.toString(), ctx.explicit);
  if (!s) return null;
  return {
    from: ctx.pos - s.back,
    options: s.labels.map((label): Completion => ({ label, type: s.help ? 'property' : 'constant', detail: s.help?.[label], apply: s.help ? `${label}: ` : label })),
  };
}

// ConfigEditor edits sumigo.yml with highlighting, completion, and the server check underlining errors as you type.
export default function ConfigEditor() {
  const { siteId } = useParams();
  const { reloadSites } = useCtx();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const sha = useRef('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const save = async () => {
    if (!view.current) return;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const res = await api<{ yaml: string; sha: string }>('PUT', `/sites/${siteId}/config`, { yaml: view.current.state.doc.toString(), sha: sha.current });
      sha.current = res.sha;
      reloadSites();
      setStatus(t('Saved'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let live = true;
    api<{ yaml: string; sha: string }>('GET', `/sites/${siteId}/config`)
      .then((res) => {
        if (!live || !host.current) return;
        sha.current = res.sha;
        const check = linter(
          async (v): Promise<Diagnostic[]> => {
            try {
              await api('POST', '/config/check', { yaml: v.state.doc.toString() });
              return [];
            } catch (err) {
              if (!(err instanceof HttpError) || err.status !== 400) return [];
              const line = Number(err.params?.line);
              const at = line > 0 && line <= v.state.doc.lines ? v.state.doc.line(line) : v.state.doc.line(1);
              return [{ from: at.from, to: at.to, severity: 'error', message: err.message }];
            }
          },
          { delay: 600 },
        );
        view.current = new EditorView({
          doc: res.yaml,
          parent: host.current,
          extensions: [
            basicSetup,
            yaml(),
            yaml().language.data.of({ autocomplete: complete }),
            check,
            // Tab indents, like in a code editor. Escape then Tab still moves the focus out, for keyboard users.
            keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) }]),
            EditorView.theme({ '&': { fontSize: '13px' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
          ],
        });
        setLoaded(true);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
      view.current?.destroy();
    };
  }, [siteId]);

  return (
    <div className="max-w-5xl">
      {/* Sticky under the app header (h-14), so saving stays at hand at the bottom of a long file. */}
      <div className="sticky top-14 z-10 -mt-3 bg-canvas pt-3">
        <PageHeader title="sumigo.yml">
          <a href="https://github.com/ermos/sumigo/blob/main/docs/sumigo-yml.md" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
            {t('sumigo.yml reference')}
          </a>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!loaded || saving} title="Cmd+S / Ctrl+S">
            <Pending on={saving}>{t(saving ? 'Committing…' : 'Save and commit')}</Pending>
          </button>
        </PageHeader>
        {(error || status) && (
          <div className="-mt-2 mb-3">
            <Notice tone={error ? 'danger' : 'ok'}>{error || status}</Notice>
          </div>
        )}
      </div>
      {!loaded && !error && <Loading>{t('Loading sumigo.yml…')}</Loading>}
      <div ref={host} className={`panel overflow-hidden [&_.cm-editor]:min-h-[32rem] [&_.cm-editor.cm-focused]:outline-none ${loaded ? '' : 'hidden'}`} />
    </div>
  );
}
