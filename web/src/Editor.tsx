import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, can, Entry, Field, Pull, Site } from './api';
import { useSite } from './Site';

type Data = Record<string, unknown>;

export default function Editor() {
  const site = useSite();
  const { col, slug } = useParams();
  const navigate = useNavigate();
  const collection = site.config?.collections.find((c) => c.name === col);
  const [data, setData] = useState<Data | null>(slug ? null : {});
  const [draft, setDraft] = useState<Pull | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/sites/${site.id}/collections/${col}/entries`;

  useEffect(() => {
    if (!slug) {
      const defaults: Data = {};
      collection?.fields.forEach((f) => f.default !== undefined && (defaults[f.name] = f.default));
      setData(defaults);
      return;
    }
    api<Entry>('GET', `${base}/${encodeURIComponent(slug)}`)
      .then((e) => {
        setData(e.data);
        setDraft(e.draft);
      })
      .catch((e) => setError(e.message));
  }, [base, slug, collection]);

  if (!collection) return <p className="muted">Unknown collection.</p>;
  const readOnly = !can(site.role, 'editor');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ slug: string; draft: Pull | null }>(slug ? 'PUT' : 'POST', slug ? `${base}/${encodeURIComponent(slug)}` : base, { data });
      setDraft(res.draft);
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
      navigate(`/sites/${site.id}/c/${col}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={save} className="editor">
      <header className="editor-head">
        <div>
          <button type="button" className="link" onClick={() => navigate(`/sites/${site.id}/c/${col}`)}>
            ← {collection.label || collection.name}
          </button>
          <h1>{slug ?? 'New entry'}</h1>
          {draft && (
            <a className="badge" href={draft.html_url} target="_blank" rel="noreferrer">
              draft · PR #{draft.number}
            </a>
          )}
        </div>
        <div className="actions">
          {status && <span className="ok small">{status}</span>}
          {slug && can(site.role, 'publisher') && (
            <button type="button" className="danger" onClick={remove}>
              Delete
            </button>
          )}
          {!readOnly && (
            <button className="primary" disabled={busy || !data}>
              {busy ? 'Saving…' : site.workflow === 'pr' ? 'Save draft' : 'Publish'}
            </button>
          )}
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {data &&
        collection.fields.map((f) => (
          <FieldInput key={f.name} site={site} field={f} value={data[f.name]} readOnly={readOnly} onChange={(v) => setData((d) => ({ ...d, [f.name]: v }))} />
        ))}
      {!data && !error && <p className="muted">Loading…</p>}
    </form>
  );
}

interface FieldProps {
  site: Site;
  field: Field;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}

// Decap semantics: fields are required unless `required: false`.
const isRequired = (f: Field) => f.required !== false && f.widget !== 'boolean';
const isPrimitive = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);

function FieldInput({ site, field, value, readOnly, onChange }: FieldProps) {
  const label = (field.label || field.name) + (isRequired(field) ? ' *' : '');
  const str = value == null ? '' : String(value);
  const common = { disabled: readOnly, required: isRequired(field) };
  let input;
  const complex = field.widget === 'object' || (field.widget === 'list' && (field.fields || (Array.isArray(value) && value.some((v) => typeof v !== 'string')))) || (!isPrimitive(value) && field.widget !== 'list');
  switch (complex ? 'json' : field.widget) {
    case 'hidden':
      return null;
    case 'json':
      input = <JsonInput value={value} onChange={onChange} readOnly={readOnly} />;
      break;
    case 'text':
      input = <textarea rows={4} value={str} onChange={(e) => onChange(e.target.value)} {...common} />;
      break;
    case 'markdown':
      return <MarkdownInput label={label} value={str} onChange={onChange} readOnly={readOnly} />;
    case 'boolean':
      return (
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={readOnly} /> {label}
        </label>
      );
    case 'number':
      input = <input type="number" value={str} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} {...common} />;
      break;
    case 'date':
      input = <input type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value)} {...common} />;
      break;
    case 'datetime':
      input = <input type="datetime-local" value={str.slice(0, 16)} onChange={(e) => onChange(e.target.value)} {...common} />;
      break;
    case 'select':
      input = (
        <select value={str} onChange={(e) => onChange(e.target.value)} {...common}>
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
      input = <input value={str} onChange={(e) => onChange(e.target.value)} {...common} />;
  }
  return (
    <label>
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
        className="mono"
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
      {invalid && <span className="error small">Invalid JSON, not applied.</span>}
    </>
  );
}

function ListInput({ value, onChange, readOnly }: { value: string[]; onChange: (v: string[]) => void; readOnly: boolean }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      value={text}
      disabled={readOnly}
      placeholder="comma, separated, values"
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

function ImageInput({ site, value, onChange, readOnly }: { site: Site; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = async (file?: File) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    setError('');
    try {
      onChange((await api<{ url: string }>('POST', `/sites/${site.id}/media`, form)).url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="image-input">
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} placeholder="/images/cover.jpg" />
      {!readOnly && <input type="file" accept="image/*" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />}
      {busy && <span className="muted small">Uploading…</span>}
      {error && <span className="error">{error}</span>}
    </span>
  );
}

function MarkdownInput({ label, value, onChange, readOnly }: { label: string; value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(value, { async: false })), [value]);
  return (
    <div className="markdown">
      <span>{label}</span>
      <div className="split">
        <textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} rows={24} />
        <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
