import { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, can, Commit, Entry, forgeNames, HttpError, EntrySummary, Field, mediaSrc, Pull, SiteDetail, uploadMedia } from './api';
import { DraftPill, Empty, entriesKey, formatDate, formatDateTime, Loading, Notice, useSite } from './Site';
import { Pending, Spinner } from './ui';
import { getCached, setCached } from './cache';
import { diffText, Part } from './diff';
import { Chevron } from './App';
import { t } from './i18n';

type Data = Record<string, unknown>;

export default function Editor() {
  const site = useSite();
  const { col, slug } = useParams();
  const navigate = useNavigate();
  const collection = site.config?.collections.find((c) => c.name === col);
  const listKey = entriesKey(site.id, col);
  // The collection list already holds every entry: open it from there, then refresh.
  const cachedEntry = () => (slug ? getCached<EntrySummary[]>(listKey)?.find((e) => e.slug === slug) : undefined);
  const [data, setData] = useState<Data | null>(() => cachedEntry()?.data ?? (slug ? null : {}));
  const [draft, setDraft] = useState<Pull | null>(() => cachedEntry()?.draft ?? null);
  const edited = useRef(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'draft' | 'publish' | 'delete' | 'discard' | null>(null);
  const [dirty, setDirty] = useState(false);
  // The right pane shows the live preview, or the history of the entry.
  const [panel, setPanel] = useState<'preview' | 'history' | null>('preview');
  // Bumped on restore so fields holding their own text state start over.
  const [formKey, setFormKey] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const base = `/sites/${site.id}/collections/${col}/entries`;

  useEffect(() => {
    if (!slug) {
      const defaults: Data = {};
      collection?.fields.forEach((f) => f.default !== undefined && (defaults[f.name] = f.default));
      setData(defaults);
      return;
    }
    const cached = cachedEntry();
    edited.current = false;
    setData(cached?.data ?? null);
    setDraft(cached?.draft ?? null);
    let live = true;
    api<Entry>('GET', `${base}/${encodeURIComponent(slug)}`)
      .then((e) => {
        // Never overwrite what the user started typing with the background refresh.
        if (!live || edited.current) return;
        setData(e.data);
        setDraft(e.draft);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, slug, collection]);

  // updateList keeps the cached collection list in sync after a save or a delete.
  const updateList = (fn: (list: EntrySummary[]) => EntrySummary[]) => {
    const list = getCached<EntrySummary[]>(listKey);
    if (list) setCached(listKey, fn(list));
  };

  // Cmd/Ctrl+S saves, and leaving the page with unsaved changes asks first.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        form.current?.requestSubmit();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [dirty]);

  if (!collection) return <Empty>{t('Unknown collection.')}</Empty>;
  const readOnly = !can(site.role, 'editor');
  // On a review site only publishers put entries live, editors save drafts for them.
  const canPublish = can(site.role, site.workflow === 'pr' ? 'publisher' : 'editor');

  // The button that submitted the form decides: "publish" puts the entry live, anything else (or Cmd+S) saves a draft.
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const publish = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.name === 'publish';
    setBusy(publish ? 'publish' : 'draft');
    setError('');
    try {
      const res = await api<{ slug: string; draft: Pull | null }>(slug ? 'PUT' : 'POST', slug ? `${base}/${encodeURIComponent(slug)}` : base, { data, publish });
      setDraft(res.draft);
      setDirty(false);
      const title = String(data?.[collection.identifier_field || 'title'] || res.slug);
      const entry: EntrySummary = {
        slug: res.slug,
        path: '',
        title,
        date: data?.date as string | undefined,
        data: data ?? {},
        draft: res.draft ?? undefined,
      };
      updateList((list) => (list.some((e) => e.slug === res.slug) ? list.map((e) => (e.slug === res.slug ? { ...e, ...entry, path: e.path } : e)) : [entry, ...list]));
      setStatus(publish ? t('Published on {branch}', { branch: site.branch }) : t('Draft saved'));
      if (!slug) navigate(`/sites/${site.id}/c/${col}/e/${encodeURIComponent(res.slug)}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // remove deletes the entry, or only its draft: the form then falls back to the published version, if any.
  const remove = async (onlyDraft: boolean) => {
    if (!slug) return;
    const url = `${base}/${encodeURIComponent(slug)}`;
    setBusy(onlyDraft ? 'discard' : 'delete');
    try {
      await api('DELETE', onlyDraft ? url + '?only=draft' : url);
      const published = onlyDraft ? await api<Entry>('GET', url).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))) : null;
      deleteDialog.current?.close();
      if (!published) {
        updateList((list) => list.filter((e) => e.slug !== slug));
        navigate(`/sites/${site.id}/c/${col}`);
        return;
      }
      setData(published.data);
      setDraft(null);
      setFormKey((k) => k + 1);
      setDirty(false);
      setStatus(t('Draft discarded'));
      updateList((list) => list.map((e) => (e.slug === slug ? { ...e, data: published.data, draft: undefined } : e)));
    } catch (err) {
      deleteDialog.current?.close();
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const change = (name: string) => (v: unknown) => {
    edited.current = true;
    setData((d) => ({ ...d, [name]: v }));
    setDirty(true);
    setStatus('');
  };
  const assist =
    site.ai && !readOnly
      ? async (f: Field, action: 'write' | 'proofread', brief?: string) => (await api<{ text: string }>('POST', `/sites/${site.id}/collections/${col}/ai`, { action, field: f.name, data, brief })).text
      : undefined;
  const field = (f: Field) => <FieldInput key={f.name} site={site} field={f} value={data?.[f.name]} readOnly={readOnly} onChange={change(f.name)} assist={assist} />;

  const setPull = (p: Pull) => {
    setDraft(p);
    updateList((list) => list.map((e) => (e.slug === slug ? { ...e, draft: p } : e)));
  };
  const restore = (version: Data) => {
    edited.current = true;
    setData(version);
    setFormKey((k) => k + 1);
    setDirty(true);
    setStatus('');
    setPanel('preview');
  };
  const togglePanel = (p: 'preview' | 'history') => setPanel(panel === p ? null : p);
  const back = `/sites/${site.id}/c/${col}`;
  const title = (data && collection.identifier_field && String(data[collection.identifier_field] ?? '')) || (data && typeof data.title === 'string' && data.title) || slug;

  const leave = (e: { preventDefault: () => void }) => dirty && !confirm(t('Leave without saving? Your changes will be lost.')) && e.preventDefault();

  return (
    <form ref={form} onSubmit={save} className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-4">
        <Link to={back} onClick={leave} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-canvas hover:text-ink">
          <Chevron dir="left" />
          {collection.label || collection.name}
        </Link>
        <span className="h-5 w-px bg-line" />
        <span className="min-w-0 truncate px-2 text-[14px] font-medium">{title || t('New entry')}</span>
        {draft && (
          <a href={draft.html_url} target="_blank" rel="noreferrer" title={t('Open the pull request on {forge}', { forge: forgeNames[site.forge] })}>
            <DraftPill pull={draft} />
          </a>
        )}
        {readOnly && <span className="pill bg-canvas text-muted ring-1 ring-line">{t('Read only')}</span>}
        <span className="flex-1" />
        {dirty ? (
          <span className="hidden items-center gap-1.5 text-[13px] text-muted sm:flex">
            <span className="size-1.5 rounded-full bg-amber-500" />
            {t('Unsaved changes')}
          </span>
        ) : (
          status && <span className="hidden text-[13px] text-ok sm:inline">{status}</span>
        )}
        <div className="hidden rounded-md bg-canvas p-0.5 ring-1 ring-line lg:flex">
          {(['preview', 'history'] as const).map(
            (p) =>
              (p === 'preview' || slug) && (
                <button
                  key={p}
                  type="button"
                  aria-pressed={panel === p}
                  onClick={() => togglePanel(p)}
                  className={`rounded px-2.5 py-1 text-[13px] font-medium ${panel === p ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'}`}
                >
                  {t(p === 'preview' ? 'Preview' : 'History')}
                </button>
              ),
          )}
        </div>
        {slug && (canPublish || (draft && !readOnly)) && (
          <button type="button" className="btn btn-danger" onClick={() => deleteDialog.current?.showModal()} disabled={!!busy}>
            {t('Delete')}
          </button>
        )}
        <dialog ref={deleteDialog} className="panel m-auto w-[calc(100%-2rem)] max-w-sm p-0 text-ink shadow-xl backdrop:bg-ink/30" onCancel={(e) => busy && e.preventDefault()}>
          <div className="flex flex-col gap-4 p-6">
            <h2>{t('Delete {name}?', { name: title || slug || '' })}</h2>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn" autoFocus onClick={() => deleteDialog.current?.close()} disabled={!!busy}>
                {t('Cancel')}
              </button>
              {draft && !readOnly && (
                <button type="button" className="btn" onClick={() => remove(true)} disabled={!!busy}>
                  <Pending on={busy === 'discard'}>{t('Discard draft')}</Pending>
                </button>
              )}
              {canPublish && (
                <button type="button" className="btn btn-danger" onClick={() => remove(false)} disabled={!!busy}>
                  <Pending on={busy === 'delete'}>{t(busy === 'delete' ? 'Deleting…' : 'Delete entry')}</Pending>
                </button>
              )}
            </div>
          </div>
        </dialog>
        {!readOnly && (
          <button name="draft" className="btn" disabled={!!busy || !data} title={t('Keeps the changes in a pull request without publishing them (Cmd+S / Ctrl+S)')}>
            <Pending on={busy === 'draft'}>{t(busy === 'draft' ? 'Saving…' : 'Save draft')}</Pending>
          </button>
        )}
        {canPublish && draft && slug && <ScheduleMenu site={site} pull={draft} dirty={dirty} onChange={setPull} />}
        {canPublish && (
          <button
            name="publish"
            className="btn btn-primary"
            disabled={!!busy || !data}
            title={
              draft
                ? t('Merges pull request #{n} into {branch}', {
                    n: draft.number,
                    branch: site.branch,
                  })
                : t('Commits to {branch}', { branch: site.branch })
            }
          >
            <Pending on={busy === 'publish'}>{t(busy === 'publish' ? 'Publishing…' : 'Publish')}</Pending>
          </button>
        )}
      </header>
      {error && (
        <div className="shrink-0 px-4 pt-3">
          <Notice>{error}</Notice>
        </div>
      )}
      {data ? (
        <div className={`grid min-h-0 flex-1 ${panel ? 'lg:grid-cols-2' : ''}`}>
          <div className="overflow-y-auto">
            <div key={formKey} className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-8 md:px-8">
              {collection.fields.map(field)}
            </div>
          </div>
          {panel && (
            <div className="hidden overflow-y-auto border-l border-line bg-surface lg:block">
              {panel === 'history' && slug ? (
                <History
                  site={site}
                  url={`${base}/${encodeURIComponent(slug)}/history`}
                  fields={collection.fields}
                  titleField={collection.identifier_field || 'title'}
                  onRestore={readOnly ? undefined : restore}
                />
              ) : (
                <Preview site={site} fields={collection.fields} titleField={collection.identifier_field || 'title'} data={data} />
              )}
            </div>
          )}
        </div>
      ) : (
        !error && <Loading />
      )}
    </form>
  );
}

const renderMarkdown = (md: string, site: SiteDetail) => {
  const doc = new DOMParser().parseFromString(DOMPurify.sanitize(marked.parse(md, { async: false })), 'text/html');
  doc.querySelectorAll('img').forEach((img) => img.setAttribute('src', mediaSrc(site, img.getAttribute('src') ?? '')));
  return doc.body.innerHTML;
};

// Preview lays the entry out as an article: title, date, lead, images and body.
function Preview({ site, fields, titleField, data }: { site: SiteDetail; fields: Field[]; titleField: string; data: Data }) {
  return (
    <article className="prose-preview mx-auto max-w-2xl px-10 py-12">
      <h1 className="text-3xl leading-tight font-semibold tracking-tight">{String(data[titleField] ?? '') || <span className="text-muted">{t('Untitled')}</span>}</h1>
      {fields.map((f) => {
        const v = data[f.name];
        if (v == null || v === '' || f.name === titleField) return null;
        switch (f.widget) {
          case 'date':
          case 'datetime':
            return (
              <p key={f.name} className="text-[13px] text-muted">
                {formatDate(String(v))}
              </p>
            );
          case 'text':
            return (
              <p key={f.name} className="text-lg text-muted">
                {String(v)}
              </p>
            );
          case 'image':
            return <img key={f.name} src={mediaSrc(site, String(v))} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />;
          case 'markdown':
            return (
              <div
                key={f.name}
                className="prose-preview"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(String(v), site),
                }}
              />
            );
          default:
            return null;
        }
      })}
    </article>
  );
}

interface FieldProps {
  site: SiteDetail;
  field: Field;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
  // assist asks the AI assistant for a value, when it is on for the site.
  assist?: (field: Field, action: 'write' | 'proofread', brief?: string) => Promise<string>;
}

// toLocalInput turns a stored ISO date into the local "YYYY-MM-DDTHH:MM" a datetime input expects.
// Values are saved back as full ISO strings so YAML reads them as dates, like Decap does.
function toLocalInput(value: string) {
  const d = new Date(value);
  if (!value || isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// Decap semantics: fields are required unless `required: false`.
const isRequired = (f: Field) => f.required !== false && f.widget !== 'boolean';
const isPrimitive = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);

function FieldInput({ site, field, value, readOnly, onChange, assist }: FieldProps) {
  const str = value == null ? '' : String(value);
  const complex =
    field.widget === 'object' || (field.widget === 'list' && (field.fields || (Array.isArray(value) && value.some((v) => typeof v !== 'string')))) || (!isPrimitive(value) && field.widget !== 'list');
  const [suggesting, setSuggesting] = useState(false);
  const [aiError, setAiError] = useState('');
  // The value before the last suggestion, to undo it.
  const [previous, setPrevious] = useState<string | null>(null);
  const suggest = async () => {
    setSuggesting(true);
    setAiError('');
    try {
      const text = await assist!(field, 'write');
      setPrevious(str);
      onChange(text);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  const canSuggest = assist && !complex && (field.widget === 'string' || field.widget === 'text');
  const label = (
    <span className="flex items-center gap-3">
      <span>
        {field.label || field.name}
        {!isRequired(field) && <span className="font-normal text-muted"> {t('(optional)')}</span>}
      </span>
      {canSuggest && (
        <span className="ml-auto flex items-center gap-3 text-xs font-medium">
          {previous !== null && !suggesting && (
            <button
              type="button"
              className="text-muted hover:text-ink"
              onClick={() => {
                onChange(previous);
                setPrevious(null);
              }}
            >
              {t('Undo')}
            </button>
          )}
          <button type="button" className="flex items-center gap-1 text-accent hover:underline disabled:no-underline disabled:opacity-60" onClick={suggest} disabled={suggesting}>
            {suggesting ? <Spinner className="size-3" /> : <Icon d={icons.sparkle} size="size-3.5" />}
            {t(suggesting ? 'Writing…' : 'Suggest')}
          </button>
        </span>
      )}
    </span>
  );
  const common = { disabled: readOnly, required: isRequired(field) };
  let input;
  switch (complex ? 'json' : field.widget) {
    case 'hidden':
      return null;
    case 'json':
      input = <JsonInput value={value} onChange={onChange} readOnly={readOnly} />;
      break;
    case 'text':
      input = <textarea className="field" rows={4} value={str} onChange={(e) => onChange(e.target.value)} {...common} />;
      break;
    case 'markdown':
      return (
        <MarkdownInput
          site={site}
          label={label}
          value={str}
          onChange={onChange}
          readOnly={readOnly}
          proofread={assist && (() => assist(field, 'proofread'))}
          suggest={assist && ((brief) => assist(field, 'write', brief))}
        />
      );
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input type="checkbox" className="size-4 accent-accent" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={readOnly} /> {label}
        </label>
      );
    case 'number':
      input = <input className="field" type="number" step="any" value={str} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} {...common} />;
      break;
    case 'date':
      input = <input className="field" type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value)} {...common} />;
      break;
    case 'datetime':
      input = <input className="field" type="datetime-local" value={toLocalInput(str)} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} {...common} />;
      break;
    case 'select':
      input = (
        <select className="field" value={str} onChange={(e) => onChange(e.target.value)} {...common}>
          <option value="" />
          {field.options?.map((o) => {
            const opt = typeof o === 'string' ? { label: o, value: o } : o;
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            );
          })}
        </select>
      );
      break;
    case 'list':
      input = <ListInput value={Array.isArray(value) ? value.map(String) : []} onChange={onChange} readOnly={readOnly} />;
      break;
    case 'image':
      input = <ImageInput site={site} value={str} onChange={onChange} readOnly={readOnly} />;
      break;
    default:
      input = <input className="field" value={str} onChange={(e) => onChange(e.target.value)} {...common} />;
  }
  return (
    <label className="label">
      {label}
      {input}
      {aiError && <span className="text-xs font-normal text-danger">{aiError}</span>}
    </label>
  );
}

// JsonInput edits nested values (object widgets, lists of objects) as raw JSON so nothing is lost.
function JsonInput({ value, onChange, readOnly }: { value: unknown; onChange: (v: unknown) => void; readOnly: boolean }) {
  const [text, setText] = useState(JSON.stringify(value ?? null, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <textarea
        className="field font-mono text-xs"
        rows={6}
        value={text}
        disabled={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <span className="text-xs font-normal text-danger">{t('Invalid JSON, changes are not applied until it parses.')}</span>}
    </>
  );
}

function ListInput({ value, onChange, readOnly }: { value: string[]; onChange: (v: string[]) => void; readOnly: boolean }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      className="field"
      value={text}
      disabled={readOnly}
      placeholder={t('comma, separated, values')}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function ImageInput({ site, value, onChange, readOnly }: { site: SiteDetail; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      onChange(await uploadMedia(site.id, file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col gap-2">
      {value && (
        <img
          key={value}
          src={mediaSrc(site, value)}
          alt=""
          className="max-h-48 max-w-sm rounded-md border border-line bg-canvas object-cover"
          onError={(e) => (e.currentTarget.style.display = 'none')}
        />
      )}
      <input className="field" value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} placeholder="/images/cover.jpg" />
      {!readOnly && (
        <span className="btn relative self-start">
          <Pending on={busy}>{t(busy ? 'Uploading…' : 'Upload an image')}</Pending>
          <input type="file" accept="image/*" disabled={busy} className="absolute inset-0 cursor-pointer opacity-0" onChange={(e) => upload(e.target.files?.[0])} />
        </span>
      )}
      {error && <span className="text-xs font-normal text-danger">{error}</span>}
    </span>
  );
}

// Lucide-style 16px stroke icons, inlined so the toolbar needs no icon package.
const icons = {
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
};

const Icon = ({ d, size = 'size-4' }: { d: string; size?: string }) => (
  <svg viewBox="0 0 24 24" className={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const BLOCK_PREFIX = /^(#{1,6} |> |[-*] |\d+\. )/;
const isMac = typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

function MarkdownInput({
  site,
  label,
  value,
  onChange,
  readOnly,
  proofread,
  suggest,
}: {
  site: SiteDetail;
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  proofread?: () => Promise<string>;
  // suggest writes the whole body from the editor's description of the article.
  suggest?: (brief: string) => Promise<string>;
}) {
  const [uploading, setUploading] = useState(false);
  const [proofing, setProofing] = useState(false);
  // review holds the AI corrections until the editor accepts or discards them.
  const [review, setReview] = useState<{ text: string; parts: Part[] } | null>(null);
  const [note, setNote] = useState('');
  const accept = () => {
    const text = review!.text;
    setReview(null);
    // After the textarea is shown again, through replace so Cmd+Z brings the original text back.
    setTimeout(() => replace(0, ref.current!.value.length, text, 0));
  };
  const [writing, setWriting] = useState(false);
  const [brief, setBrief] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const write = async () => {
    if (!brief.trim() || writing) return;
    setWriting(true);
    setError('');
    try {
      const text = await suggest!(brief);
      // Through replace, so Cmd+Z brings the previous text back.
      if (text) replace(0, ref.current!.value.length, text, 0);
      dialog.current?.close();
    } catch (e) {
      setError((e as Error).message);
      dialog.current?.close();
    } finally {
      setWriting(false);
    }
  };
  const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // replace goes through execCommand so the browser keeps Cmd+Z working, then selects [selStart, selEnd).
  const replace = (from: number, to: number, text: string, selStart = from + text.length, selEnd = selStart) => {
    const ta = ref.current!;
    ta.focus();
    ta.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) onChange(ta.value.slice(0, from) + text + ta.value.slice(to));
    requestAnimationFrame(() => ta.setSelectionRange(selStart, selEnd));
  };
  const sel = () => {
    const { selectionStart: s, selectionEnd: e, value: v } = ref.current!;
    return { s, e, v, text: v.slice(s, e) };
  };

  const wrap = (before: string, after = before, placeholder = t('text')) => {
    const { s, e, text } = sel();
    const label = text || placeholder;
    replace(s, e, before + label + after, s + before.length, s + before.length + label.length);
  };

  // block toggles a line prefix (heading, quote, list) on every selected line.
  const block = (re: RegExp, make: (i: number) => string) => {
    const { s, e, v } = sel();
    const from = v.lastIndexOf('\n', s - 1) + 1;
    const lines = v.slice(from, e).split('\n');
    const on = lines.every((l) => re.test(l));
    const text = lines.map((l, i) => (on ? l.replace(re, '') : make(i) + l.replace(BLOCK_PREFIX, ''))).join('\n');
    replace(from, e, text, from + text.length);
  };

  const link = (url = 'https://') => {
    const { s, e, text } = sel();
    const label = text || t('link text');
    const md = `[${label}](${url})`;
    replace(s, e, md, text ? s + label.length + 3 : s + 1, text ? s + md.length - 1 : s + 1 + label.length);
  };

  const code = () => (sel().text.includes('\n') ? wrap('```\n', '\n```', 'code') : wrap('`', '`', 'code'));

  const insertImage = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const url = await uploadMedia(site.id, file);
      const { s, e } = sel();
      replace(s, e, `![${file.name.replace(/\.[^.]+$/, '')}](${url})`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const tools: {
    title: string;
    icon: ReactNode;
    run: () => void;
    key?: string;
  }[][] = [
    [
      {
        title: t('Heading'),
        icon: <span className="text-[13px] font-semibold">H2</span>,
        run: () => block(/^## /, () => '## '),
      },
      {
        title: t('Subheading'),
        icon: <span className="text-[13px] font-semibold">H3</span>,
        run: () => block(/^### /, () => '### '),
      },
    ],
    [
      {
        title: t('Bold'),
        icon: <Icon d={icons.bold} />,
        run: () => wrap('**'),
        key: 'b',
      },
      {
        title: t('Italic'),
        icon: <Icon d={icons.italic} />,
        run: () => wrap('_'),
        key: 'i',
      },
      {
        title: t('Strikethrough'),
        icon: <Icon d={icons.strike} />,
        run: () => wrap('~~'),
      },
    ],
    [
      {
        title: t('Link'),
        icon: <Icon d={icons.link} />,
        run: () => link(),
        key: 'k',
      },
      {
        title: t('Quote'),
        icon: <Icon d={icons.quote} />,
        run: () => block(/^> /, () => '> '),
      },
      { title: t('Code'), icon: <Icon d={icons.code} />, run: code, key: 'e' },
    ],
    [
      {
        title: t('Bulleted list'),
        icon: <Icon d={icons.ul} />,
        run: () => block(/^[-*] /, () => '- '),
      },
      {
        title: t('Numbered list'),
        icon: <Icon d={icons.ol} />,
        run: () => block(/^\d+\. /, (i) => `${i + 1}. `),
      },
    ],
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey || e.ctrlKey) {
      const tool = tools.flat().find((t) => t.key === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        tool.run();
      }
      return;
    }
    // Enter inside a list continues it; Enter on an empty item ends it.
    if (e.key === 'Enter' && !e.shiftKey) {
      const { s, e: end, v } = sel();
      if (s !== end) return;
      const from = v.lastIndexOf('\n', s - 1) + 1;
      const m = v.slice(from, s).match(/^(\s*)([-*] |(\d+)\. |> )(.*)$/);
      if (!m) return;
      e.preventDefault();
      if (!m[4]) return replace(from, s, '');
      replace(s, s, '\n' + m[1] + (m[3] ? `${Number(m[3]) + 1}. ` : m[2]));
    }
  };

  // Pasting a URL over selected text makes a link, pasting or dropping an image uploads it.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const img = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    const url = e.clipboardData.getData('text').trim();
    if (img) {
      e.preventDefault();
      insertImage(img);
    } else if (sel().text && /^https?:\/\/\S+$/.test(url)) {
      e.preventDefault();
      link(url);
    }
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const img = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    insertImage(img);
  };

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const btn = 'grid size-7 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-ink hover:shadow-xs hover:ring-1 hover:ring-line disabled:opacity-40';

  return (
    <div className="label">
      {label}
      <div className="panel focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded-t-lg border-b border-line bg-surface px-2 py-1.5">
          {!readOnly && (
            <div role="toolbar" aria-label={t('Formatting')} className={`flex flex-wrap items-center ${review ? 'pointer-events-none opacity-40' : ''}`}>
              {tools.map((group, i) => (
                <div key={i} className="mr-1.5 flex items-center gap-0.5 border-r border-line pr-1.5">
                  {group.map((t) => (
                    <button
                      key={t.title}
                      type="button"
                      className={btn}
                      title={t.key ? `${t.title} (${mod}${t.key.toUpperCase()})` : t.title}
                      aria-label={t.title}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={t.run}
                    >
                      {t.icon}
                    </button>
                  ))}
                </div>
              ))}
              <button
                type="button"
                className={btn}
                title={t('Insert an image (or paste / drop one in the text)')}
                aria-label={t('Insert an image')}
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Icon d={icons.image} />
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && insertImage(e.target.files[0])} />
              {uploading && (
                <span className="ml-2 flex items-center gap-1.5 text-xs font-normal text-muted">
                  <Spinner className="size-3 text-accent" />
                  {t('Uploading image…')}
                </span>
              )}
            </div>
          )}
          {suggest && !readOnly && (
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-60"
              disabled={writing || proofing}
              onClick={() => dialog.current?.showModal()}
            >
              {writing ? <Spinner className="size-3" /> : <Icon d={icons.sparkle} size="size-3.5" />}
              {t(writing ? 'Writing…' : 'Suggest')}
            </button>
          )}
          {proofread && !readOnly && (
            <button
              type="button"
              className={`${suggest ? '' : 'ml-auto'} flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-60`}
              disabled={proofing || !!review || !value.trim()}
              title={t('Fixes spelling and grammar without changing the content.')}
              onClick={async () => {
                setProofing(true);
                setError('');
                setNote('');
                try {
                  const text = await proofread();
                  const parts = diffText(value, text);
                  if (!text || parts.every((p) => p.same)) setNote(t('No correction needed.'));
                  else setReview({ text, parts });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setProofing(false);
                }
              }}
            >
              {proofing ? <Spinner className="size-3" /> : <Icon d={icons.sparkle} size="size-3.5" />}
              {t(proofing ? 'Proofreading…' : 'Proofread')}
            </button>
          )}
          {suggest && (
            <dialog ref={dialog} className="panel m-auto w-[calc(100%-2rem)] max-w-lg p-0 text-ink shadow-xl backdrop:bg-ink/30" onCancel={(e) => writing && e.preventDefault()}>
              <div className="flex flex-col gap-4 p-6">
                <h2>{t('Write the article')}</h2>
                <textarea
                  className="field min-h-36 font-normal"
                  value={brief}
                  autoFocus
                  onChange={(e) => setBrief(e.target.value)}
                  onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && write()}
                  placeholder={t('Topic, audience, key points, tone…')}
                  aria-label={t('Describe the article')}
                />
                {value.trim() && <p className="text-xs font-normal text-muted">{t('Replaces the current content (Cmd+Z to undo).')}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => dialog.current?.close()} disabled={writing}>
                    {t('Cancel')}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={write} disabled={writing || !brief.trim()}>
                    <Pending on={writing}>{t(writing ? 'Writing…' : 'Write')}</Pending>
                  </button>
                </div>
              </div>
            </dialog>
          )}
          <span className={`${(proofread || suggest) && !readOnly ? '' : 'ml-auto'} pr-1 text-xs font-normal text-muted tabular-nums`}>{t('{n} words', { n: words })}</span>
        </div>
        {error && <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs font-normal text-danger">{error}</p>}
        {note && <p className="border-b border-line bg-ok/5 px-4 py-2 text-xs font-normal text-ok">{note}</p>}
        {review && (
          <>
            <div className="flex items-center gap-2 border-b border-line bg-accent-soft/60 px-4 py-2 text-xs font-normal">
              <span className="mr-auto text-ink">{t('{n} corrections', { n: review.parts.filter((p) => !p.same).length })}</span>
              <button type="button" className="btn py-1" onClick={() => setReview(null)}>
                {t('Discard')}
              </button>
              <button type="button" className="btn btn-primary py-1" onClick={accept}>
                {t('Accept')}
              </button>
            </div>
            <Corrections parts={review.parts} />
          </>
        )}
        <textarea
          ref={ref}
          hidden={!!review}
          className="block min-h-[28rem] w-full resize-none rounded-b-lg bg-transparent px-5 py-4 text-[15px] leading-7 font-normal field-sizing-content focus:outline-none"
          value={value}
          onChange={(e) => {
            setNote('');
            onChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          disabled={readOnly}
          placeholder={t('Start writing. Markdown works, and you can paste or drop images here.')}
          aria-label={t('Content')}
        />
      </div>
    </div>
  );
}

const defaultScheduleTime = () => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  return d;
};

// ScheduleMenu plans when the draft gets published, by the server, even with the CMS closed.
function ScheduleMenu({ site, pull, dirty, onChange }: { site: SiteDetail; pull: Pull; dirty: boolean; onChange: (p: Pull) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [at, setAt] = useState(() => toLocalInput((pull.scheduled_at ? new Date(pull.scheduled_at) : defaultScheduleTime()).toISOString()));
  const [busy, setBusy] = useState<'set' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const run = async (kind: 'set' | 'cancel') => {
    setBusy(kind);
    setError('');
    try {
      const url = `/sites/${site.id}/pulls/${pull.number}/schedule`;
      if (kind === 'set') onChange(await api<Pull>('PUT', url, { publish_at: new Date(at).toISOString() }));
      else {
        await api('DELETE', url);
        onChange({ ...pull, scheduled_at: undefined });
      }
      menu.current?.removeAttribute('open');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <details ref={menu} className="relative">
      <summary className="btn cursor-pointer list-none">{t(pull.scheduled_at ? 'Scheduled' : 'Schedule')}</summary>
      <div className="panel absolute top-full right-0 z-30 mt-2 flex w-72 flex-col gap-3 p-4 shadow-lg">
        <label className="label">
          {t('Publish on')}
          <input className="field" type="datetime-local" value={at} min={toLocalInput(new Date().toISOString())} onChange={(e) => setAt(e.target.value)} />
        </label>
        {dirty && <p className="text-xs text-muted">{t('Save the draft first.')}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          {pull.scheduled_at && (
            <button type="button" className="btn" onClick={() => run('cancel')} disabled={!!busy}>
              <Pending on={busy === 'cancel'}>{t('Cancel schedule')}</Pending>
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => run('set')} disabled={!!busy || dirty || !at}>
            <Pending on={busy === 'set'}>{t(pull.scheduled_at ? 'Reschedule' : 'Schedule')}</Pending>
          </button>
        </div>
      </div>
    </details>
  );
}

// History lists the versions of an entry. Picking one previews it, and restoring loads it into the form.
function History({ site, url, fields, titleField, onRestore }: { site: SiteDetail; url: string; fields: Field[]; titleField: string; onRestore?: (data: Data) => void }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [version, setVersion] = useState<{ data: Data; patch: string } | null>(null);
  const [mode, setMode] = useState<'changes' | 'preview'>('changes');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Commit[]>('GET', url)
      .then(setCommits)
      .catch((e) => setError(e.message));
  }, [url]);

  const open = (c: Commit) => {
    setSelected(c);
    setVersion(null);
    setError('');
    api<{ data: Data; patch: string }>('GET', `${url}/${c.sha}`)
      .then(setVersion)
      .catch((e) => setError(e.message));
  };

  if (selected) {
    return (
      <div>
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface/95 px-6 py-3 backdrop-blur">
          <button type="button" className="flex items-center gap-1 text-[13px] text-muted hover:text-ink" onClick={() => setSelected(null)}>
            <Chevron dir="left" />
            {t('History')}
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px]">{t('Version of {date} by {author}', { date: formatDateTime(selected.date), author: selected.author })}</span>
          <div className="flex rounded-md bg-canvas p-0.5 ring-1 ring-line">
            {(['changes', 'preview'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded px-2.5 py-1 text-[13px] font-medium ${mode === m ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'}`}
              >
                {t(m === 'changes' ? 'Changes' : 'Preview')}
              </button>
            ))}
          </div>
          {onRestore && (
            <button type="button" className="btn btn-primary" disabled={!version} onClick={() => version && onRestore(version.data)} title={t('Loads this version in the form. Save it to keep it.')}>
              {t('Restore')}
            </button>
          )}
        </div>
        {error && (
          <div className="p-6">
            <Notice>{error}</Notice>
          </div>
        )}
        {!version ? (
          !error && <Loading />
        ) : mode === 'preview' ? (
          <Preview site={site} fields={fields} titleField={titleField} data={version.data} />
        ) : version.patch ? (
          <Patch patch={version.patch} />
        ) : (
          <Empty>{t('No diff available for this version.')}</Empty>
        )}
      </div>
    );
  }
  return (
    <div className="px-6 py-8">
      <h2 className="mb-4">{t('History')}</h2>
      {error && <Notice>{error}</Notice>}
      {!commits && !error && <Loading />}
      {commits?.length === 0 && <Empty>{t('No version yet.')}</Empty>}
      <ol className="panel divide-y divide-line">
        {commits?.map((c, i) => (
          <li key={c.sha}>
            <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/60" onClick={() => open(c)}>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">
                  {formatDateTime(c.date)}
                  {i === 0 && <span className="pill ml-2 bg-canvas text-muted ring-1 ring-line">{t('Latest')}</span>}
                </span>
                <span className="block truncate text-xs text-muted">
                  {c.author}, {c.message}
                </span>
              </span>
              <Chevron dir="right" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

const lineTone: Record<string, string> = { '+': 'bg-ok/10', '-': 'bg-danger/10', '@': 'bg-canvas text-muted', '\\': 'text-muted' };

// Patch shows a git diff in red and green. Removed lines followed by added ones are paired,
// and the words that changed between them are highlighted darker.
function Patch({ patch }: { patch: string }) {
  const rows = patch.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i][0] !== '-') {
      out.push(<PatchLine key={i} sign={rows[i][0] ?? ' '} text={rows[i].slice(1)} />);
      i++;
      continue;
    }
    const del: string[] = [];
    const add: string[] = [];
    const start = i;
    while (rows[i]?.[0] === '-') del.push(rows[i++].slice(1));
    while (rows[i]?.[0] === '+') add.push(rows[i++].slice(1));
    const pairs = del.map((d, k) => (add[k] !== undefined ? diffText(d, add[k]) : undefined));
    del.forEach((d, k) => out.push(<PatchLine key={`${start}-${k}`} sign="-" text={d} parts={pairs[k]} />));
    add.forEach((a, k) => out.push(<PatchLine key={`${start}+${k}`} sign="+" text={a} parts={pairs[k]} />));
  }
  return <div className="py-4 font-mono text-xs leading-5">{out}</div>;
}

function PatchLine({ sign, text, parts }: { sign: string; text: string; parts?: Part[] }) {
  const mark = sign === '-' ? 'rounded-sm bg-danger/25' : 'rounded-sm bg-ok/25';
  return (
    <div className={`flex gap-3 px-6 ${lineTone[sign] ?? ''}`}>
      <span aria-hidden className={`w-3 shrink-0 select-none ${sign === '-' ? 'text-danger' : sign === '+' ? 'text-ok' : 'text-muted'}`}>
        {sign === '@' || sign === '\\' ? '' : sign}
      </span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {sign === '@' || sign === '\\'
          ? sign + text
          : parts
            ? parts.map((p, k) =>
                p.same ? (
                  p.text
                ) : (
                  <span key={k} className={mark}>
                    {sign === '-' ? p.old : p.new}
                  </span>
                ),
              )
            : text || ' '}
      </span>
    </div>
  );
}

// Corrections shows the corrected text with each change highlighted. Hovering or focusing one
// shows what it was: the old text struck through, an arrow, the new text.
function Corrections({ parts }: { parts: Part[] }) {
  return (
    <div className="min-h-[28rem] px-5 py-4 text-[15px] leading-7 font-normal break-words whitespace-pre-wrap">
      {parts.map((p, k) =>
        p.same ? (
          p.text
        ) : (
          <span
            key={k}
            tabIndex={0}
            className={`group relative rounded-sm outline-none focus:ring-2 focus:ring-accent/40 ${p.new ? 'bg-ok/15 underline decoration-ok/60 decoration-2 underline-offset-4' : 'bg-danger/10 text-danger line-through'}`}
          >
            {p.new || p.old}
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-max max-w-xs -translate-x-1/2 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-5 whitespace-pre-wrap text-white no-underline shadow-lg group-hover:block group-focus:block"
            >
              {p.old ? <s className="text-red-300">{p.old}</s> : <span className="text-white/60">{t('added')}</span>}
              <span className="mx-1.5 text-white/60">→</span>
              {p.new ? <span className="text-green-300">{p.new}</span> : <span className="text-white/60">{t('removed')}</span>}
            </span>
          </span>
        ),
      )}
    </div>
  );
}
