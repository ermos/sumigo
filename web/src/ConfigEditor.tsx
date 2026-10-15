import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { basicSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { Diagnostic, linter } from '@codemirror/lint';
import { Document, isMap, parseDocument } from 'yaml';
import { api, HttpError } from './api';
import { useCtx } from './App';
import { Loading, Notice, PageHeader } from './Site';
import { Pending } from './ui';
import ConfigForm from './ConfigForm';
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

type Mode = 'form' | 'code';
const storedMode = (): Mode => {
  try {
    return localStorage.getItem('configMode') === 'code' ? 'code' : 'form';
  } catch {
    return 'form';
  }
};

// formDoc parses YAML for the form, or returns the reason it cannot: the form needs a map at the root.
function formDoc(text: string): Document | string {
  const doc = parseDocument(text);
  if (doc.errors.length) return doc.errors[0].message;
  return doc.contents === null || isMap(doc.contents) ? doc : t('The root must be a map of keys.');
}
// Written like the docs: { a: b } maps and [a, b] lists. The yaml library pads both, so lists lose their spaces after.
const yamlText = (doc: Document) => doc.toString({ lineWidth: 0 }).replace(/\[ ([^[\]\n]*?) \]/g, '[$1]');

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
  const [mode, setMode] = useState<Mode>(storedMode);
  // doc is the form state, edited in place. dirty tells the code view to take its text on the next switch.
  const doc = useRef<Document | null>(null);
  const dirty = useRef(false);
  const [rev, setRev] = useState(0);

  const text = () => (mode === 'form' && doc.current ? yamlText(doc.current) : (view.current?.state.doc.toString() ?? ''));
  const switchTo = (m: Mode) => {
    if (m === mode || !view.current) return;
    if (m === 'form') {
      const d = formDoc(view.current.state.doc.toString());
      if (typeof d === 'string') return setError(t('Invalid YAML: {error}', { error: d }));
      doc.current = d;
    } else if (doc.current && dirty.current) {
      view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: yamlText(doc.current) } });
    }
    dirty.current = false;
    setError('');
    setMode(m);
    try {
      localStorage.setItem('configMode', m);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  };

  const save = async () => {
    if (!view.current) return;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const res = await api<{ yaml: string; sha: string }>('PUT', `/sites/${siteId}/config`, { yaml: text(), sha: sha.current });
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
        const d = formDoc(res.yaml);
        if (typeof d === 'string') setMode('code');
        else doc.current = d;
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

  // The code view underlines errors itself. In the form, the same server check shows above it.
  useEffect(() => {
    if (mode !== 'form' || !rev || !doc.current) return;
    const yaml = yamlText(doc.current);
    const id = setTimeout(() => {
      api('POST', '/config/check', { yaml })
        .then(() => setError(''))
        .catch((err) => err instanceof HttpError && err.status === 400 && setError(err.message));
    }, 600);
    return () => clearTimeout(id);
  }, [rev, mode]);

  return (
    <div className="max-w-5xl">
      {/* Sticky under the app header (h-14), so saving stays at hand at the bottom of a long file. */}
      <div className="sticky top-14 z-10 -mt-3 bg-canvas pt-3">
        <PageHeader title="sumigo.yml">
          <a href="https://ermos.github.io/sumigo/configuration/sumigo-yml" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
            {t('sumigo.yml reference')}
          </a>
          <div role="tablist" className="flex rounded-md bg-surface p-0.5 ring-1 ring-line">
            {(['form', 'code'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                disabled={!loaded}
                onClick={() => switchTo(m)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${mode === m ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
              >
                {t(m === 'form' ? 'Form' : 'Code')}
              </button>
            ))}
          </div>
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
      {loaded && mode === 'form' && doc.current && (
        <div
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              save();
            }
          }}
        >
          <ConfigForm
            doc={doc.current}
            onChange={() => {
              dirty.current = true;
              setStatus('');
              setRev((r) => r + 1);
            }}
          />
        </div>
      )}
      <div ref={host} className={`panel overflow-hidden [&_.cm-editor]:min-h-[32rem] [&_.cm-editor.cm-focused]:outline-none ${loaded && mode === 'code' ? '' : 'hidden'}`} />
    </div>
  );
}
