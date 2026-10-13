import { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, can, Entry, EntrySummary, Field, mediaSrc, Pull, SiteDetail, uploadMedia } from './api';
import { DraftPill, entriesKey, formatDate, Loading, Notice, useSite } from './Site';
import { getCached, setCached } from './cache';
import { Chevron } from './App';

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
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(true);
  const form = useRef<HTMLFormElement>(null);
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

  if (!collection) return <Loading>Unknown collection.</Loading>;
  const readOnly = !can(site.role, 'editor');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ slug: string; draft: Pull | null }>(slug ? 'PUT' : 'POST', slug ? `${base}/${encodeURIComponent(slug)}` : base, { data });
      setDraft(res.draft);
      setDirty(false);
      const title = String(data?.[collection.identifier_field || 'title'] || res.slug);
      const entry: EntrySummary = { slug: res.slug, path: '', title, date: data?.date as string | undefined, data: data ?? {}, draft: res.draft ?? undefined };
      updateList((list) => (list.some((e) => e.slug === res.slug) ? list.map((e) => (e.slug === res.slug ? { ...e, ...entry, path: e.path } : e)) : [entry, ...list]));
      setStatus(res.draft ? `Saved to pull request #${res.draft.number}` : `Committed to ${site.branch}`);
      if (!slug) navigate(`/sites/${site.id}/c/${col}/e/${encodeURIComponent(res.slug)}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!slug || !confirm(`Delete ${slug}? ${draft ? 'The draft pull request will be closed.' : 'This commits the deletion.'}`)) return;
    try {
      await api('DELETE', `${base}/${encodeURIComponent(slug)}`);
      updateList((list) => list.filter((e) => e.slug !== slug));
      navigate(`/sites/${site.id}/c/${col}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const change = (name: string) => (v: unknown) => {
    edited.current = true;
    setData((d) => ({ ...d, [name]: v }));
    setDirty(true);
    setStatus('');
  };
  const field = (f: Field) => <FieldInput key={f.name} site={site} field={f} value={data?.[f.name]} readOnly={readOnly} onChange={change(f.name)} />;
  const back = `/sites/${site.id}/c/${col}`;
  const title = (data && collection.identifier_field && String(data[collection.identifier_field] ?? '')) || (data && typeof data.title === 'string' && data.title) || slug;

  const leave = (e: { preventDefault: () => void }) => dirty && !confirm('Leave without saving? Your changes will be lost.') && e.preventDefault();

  return (
    <form ref={form} onSubmit={save} className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-4">
        <Link to={back} onClick={leave} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-canvas hover:text-ink">
          <Chevron dir="left" />
          {collection.label || collection.name}
        </Link>
        <span className="h-5 w-px bg-line" />
        <span className="min-w-0 truncate px-2 text-[14px] font-medium">{title || 'New entry'}</span>
        {draft && (
          <a href={draft.html_url} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
            <DraftPill pull={draft} />
          </a>
        )}
        {readOnly && <span className="pill bg-canvas text-muted ring-1 ring-line">Read only</span>}
        <span className="flex-1" />
        {dirty ? (
          <span className="hidden items-center gap-1.5 text-[13px] text-muted sm:flex">
            <span className="size-1.5 rounded-full bg-amber-500" />
            Unsaved changes
          </span>
        ) : (
          status && <span className="hidden text-[13px] text-ok sm:inline">{status}</span>
        )}
        <button type="button" className="btn hidden lg:inline-flex" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? 'Hide preview' : 'Show preview'}
        </button>
        {slug && can(site.role, 'publisher') && (
          <button type="button" className="btn btn-danger" onClick={remove}>
            Delete
          </button>
        )}
        {!readOnly && (
          <button className="btn btn-primary" disabled={busy || !data} title="Cmd+S / Ctrl+S">
            {busy ? 'Saving…' : site.workflow === 'pr' ? 'Save draft' : 'Publish'}
          </button>
        )}
      </header>
      {error && (
        <div className="shrink-0 px-4 pt-3">
          <Notice>{error}</Notice>
        </div>
      )}
      {data ? (
        <div className={`grid min-h-0 flex-1 ${preview ? 'lg:grid-cols-2' : ''}`}>
          <div className="overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-8 md:px-8">{collection.fields.map(field)}</div>
          </div>
          {preview && (
            <div className="hidden overflow-y-auto border-l border-line bg-surface lg:block">
              <Preview site={site} fields={collection.fields} titleField={collection.identifier_field || 'title'} data={data} />
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
      <h1 className="text-3xl leading-tight font-semibold tracking-tight">{String(data[titleField] ?? '') || <span className="text-muted">Untitled</span>}</h1>
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
            return <div key={f.name} className="prose-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(v), site) }} />;
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

function FieldInput({ site, field, value, readOnly, onChange }: FieldProps) {
  const label = (
    <span>
      {field.label || field.name}
      {!isRequired(field) && <span className="font-normal text-muted"> (optional)</span>}
    </span>
  );
  const str = value == null ? '' : String(value);
  const common = { disabled: readOnly, required: isRequired(field) };
  let input;
  const complex =
    field.widget === 'object' || (field.widget === 'list' && (field.fields || (Array.isArray(value) && value.some((v) => typeof v !== 'string')))) || (!isPrimitive(value) && field.widget !== 'list');
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
      return <MarkdownInput site={site} label={label} value={str} onChange={onChange} readOnly={readOnly} />;
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
      {invalid && <span className="text-xs font-normal text-danger">Invalid JSON, changes are not applied until it parses.</span>}
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
      placeholder="comma, separated, values"
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
          {busy ? 'Uploading…' : 'Upload an image'}
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
};

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const BLOCK_PREFIX = /^(#{1,6} |> |[-*] |\d+\. )/;
const isMac = typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

function MarkdownInput({ site, label, value, onChange, readOnly }: { site: SiteDetail; label: ReactNode; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const [uploading, setUploading] = useState(false);
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

  const wrap = (before: string, after = before, placeholder = 'text') => {
    const { s, e, text } = sel();
    const t = text || placeholder;
    replace(s, e, before + t + after, s + before.length, s + before.length + t.length);
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
    const t = text || 'link text';
    const md = `[${t}](${url})`;
    replace(s, e, md, text ? s + t.length + 3 : s + 1, text ? s + md.length - 1 : s + 1 + t.length);
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

  const tools: { title: string; icon: ReactNode; run: () => void; key?: string }[][] = [
    [
      { title: 'Heading', icon: <span className="text-[13px] font-semibold">H2</span>, run: () => block(/^## /, () => '## ') },
      { title: 'Subheading', icon: <span className="text-[13px] font-semibold">H3</span>, run: () => block(/^### /, () => '### ') },
    ],
    [
      { title: 'Bold', icon: <Icon d={icons.bold} />, run: () => wrap('**'), key: 'b' },
      { title: 'Italic', icon: <Icon d={icons.italic} />, run: () => wrap('_'), key: 'i' },
      { title: 'Strikethrough', icon: <Icon d={icons.strike} />, run: () => wrap('~~') },
    ],
    [
      { title: 'Link', icon: <Icon d={icons.link} />, run: () => link(), key: 'k' },
      { title: 'Quote', icon: <Icon d={icons.quote} />, run: () => block(/^> /, () => '> ') },
      { title: 'Code', icon: <Icon d={icons.code} />, run: code, key: 'e' },
    ],
    [
      { title: 'Bulleted list', icon: <Icon d={icons.ul} />, run: () => block(/^[-*] /, () => '- ') },
      { title: 'Numbered list', icon: <Icon d={icons.ol} />, run: () => block(/^\d+\. /, (i) => `${i + 1}. `) },
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
            <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center">
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
                title="Insert an image (or paste / drop one in the text)"
                aria-label="Insert an image"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Icon d={icons.image} />
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && insertImage(e.target.files[0])} />
              {uploading && <span className="ml-2 text-xs font-normal text-muted">Uploading image…</span>}
            </div>
          )}
          <span className="ml-auto pr-1 text-xs font-normal text-muted tabular-nums">{words} words</span>
        </div>
        {error && <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs font-normal text-danger">{error}</p>}
        <textarea
          ref={ref}
          className="block min-h-[28rem] w-full resize-none rounded-b-lg bg-transparent px-5 py-4 text-[15px] leading-7 font-normal field-sizing-content focus:outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          disabled={readOnly}
          placeholder="Start writing. Markdown works, and you can paste or drop images here."
          aria-label="Content"
        />
      </div>
    </div>
  );
}
