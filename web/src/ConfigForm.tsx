import { ReactNode, useState } from 'react';
import { Document } from 'yaml';
import { editor, Edit, Path } from './configedit';
import { widgets } from './yamlcomplete';
import { lang, t } from './i18n';

type Field = { name?: string; label?: string; widget?: string; required?: boolean; options?: unknown[]; fields?: Field[]; collection?: string; value_field?: string; display_fields?: string[]; multiple?: boolean; i18n?: unknown };
type Collection = { name?: string; label?: string; folder?: string; extension?: string; slug?: string; identifier_field?: string; create?: boolean; i18n?: boolean; fields?: Field[]; seo?: Record<string, string | boolean> };
type Config = { media_folder?: string; public_folder?: string; i18n?: { structure?: string; locales?: string[]; default_locale?: string }; collections?: Collection[] };

const Text = ({ label, value, onChange, placeholder }: { label: string; value?: string; onChange: (v: string) => void; placeholder?: string }) => (
  <label className="label">
    {label}
    <input className="field" value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </label>
);

// List is a comma separated input, committed on blur so a trailing comma can be typed.
const List = ({ label, value, onChange, placeholder }: { label: string; value?: unknown[]; onChange: (v: string[]) => void; placeholder?: string }) => {
  const plain = (value ?? []).every((x) => typeof x !== 'object');
  const text = plain ? (value ?? []).join(', ') : '';
  return (
    <label className="label">
      {label}
      <input
        key={text}
        className="field"
        defaultValue={text}
        disabled={!plain}
        placeholder={plain ? placeholder : t('Edit in code')}
        onBlur={(e) => e.target.value !== text && onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
      />
    </label>
  );
};

const Select = ({ label, value, onChange, options }: { label: string; value?: string; onChange: (v: string) => void; options: [string, string][] }) => (
  <label className="label">
    {label}
    <select className="field" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  </label>
);

const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="flex items-center gap-2 text-[13px] font-medium">
    <input type="checkbox" className="accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

const Section = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="panel flex flex-col gap-4 p-5">
    <div className="flex items-center justify-between gap-3">
      <h2>{title}</h2>
      {actions}
    </div>
    {children}
  </section>
);

const Arrows = ({ edit, path, i, n }: { edit: Edit; path: Path; i: number; n: number }) => (
  <>
    <button type="button" className="btn px-2" aria-label={t('Move up')} disabled={i === 0} onClick={() => edit.move(path, i, i - 1)}>
      ↑
    </button>
    <button type="button" className="btn px-2" aria-label={t('Move down')} disabled={i === n - 1} onClick={() => edit.move(path, i, i + 1)}>
      ↓
    </button>
  </>
);

const fieldNames = (fields?: Field[]): [string, string][] => [['', '-'], ...(fields ?? []).filter((f) => f.name).map((f): [string, string] => [f.name!, f.label || f.name!])];
const i18nValue = (v: unknown) => (v === true || v === 'translate' ? 'translate' : v === 'duplicate' ? 'duplicate' : '');

function Fields({ edit, path, fields, cfg, translated }: { edit: Edit; path: Path; fields?: Field[]; cfg: Config; translated: boolean }) {
  const list = fields ?? [];
  return (
    <div className="flex flex-col gap-3">
      {list.map((f, j) => {
        const at = [...path, j];
        const set = (k: string, v: unknown) => edit.set([...at, k], v);
        return (
          <div key={j} className="flex flex-col gap-3 rounded-md border border-line p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_10rem_auto]">
              <Text label={t('Name')} value={f.name} placeholder="title" onChange={(v) => set('name', v)} />
              <Text label={t('Label')} value={f.label} placeholder={t('Title')} onChange={(v) => set('label', v)} />
              <Select label={t('Widget')} value={f.widget} onChange={(v) => set('widget', v)} options={[['', '-'], ...widgets.map((w): [string, string] => [w, w])]} />
              <div className="flex items-end gap-1">
                <Arrows edit={edit} path={path} i={j} n={list.length} />
                <button type="button" className="btn btn-danger px-2" aria-label={t('Delete')} onClick={() => edit.del(at)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Check label={t('Required')} checked={f.required !== false} onChange={(v) => set('required', v ? undefined : false)} />
              {translated && (
                <select className="field w-auto" aria-label={t('Translation')} value={i18nValue(f.i18n)} onChange={(e) => set('i18n', e.target.value === 'translate' ? true : e.target.value)}>
                  <option value="">{t('Default locale only')}</option>
                  <option value="translate">{t('Translated')}</option>
                  <option value="duplicate">{t('Copied to every locale')}</option>
                </select>
              )}
            </div>
            {f.widget === 'select' && <List label={t('Options')} value={f.options} placeholder="draft, published" onChange={(v) => set('options', v)} />}
            {f.widget === 'relation' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select label={t('Collection')} value={f.collection} onChange={(v) => set('collection', v)} options={[['', '-'], ...(cfg.collections ?? []).filter((c) => c.name).map((c): [string, string] => [c.name!, c.label || c.name!])]} />
                <Text label={t('Stored value')} value={f.value_field} placeholder="{{slug}}" onChange={(v) => set('value_field', v)} />
                <List label={t('Shown fields')} value={f.display_fields} placeholder="title" onChange={(v) => set('display_fields', v)} />
                <div className="flex items-end pb-2">
                  <Check label={t('Several entries')} checked={!!f.multiple} onChange={(v) => set('multiple', v || undefined)} />
                </div>
              </div>
            )}
            {(f.widget === 'object' || f.widget === 'list') && (
              <div className="border-l-2 border-line pl-3">
                <Fields edit={edit} path={[...at, 'fields']} fields={f.fields} cfg={cfg} translated={translated} />
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="btn self-start" onClick={() => edit.push(path, { name: '', widget: 'string' })}>
        {t('Add a field')}
      </button>
    </div>
  );
}

function CollectionForm({ edit, c, i, n, cfg, open }: { edit: Edit; c: Collection; i: number; n: number; cfg: Config; open: boolean }) {
  const at: Path = ['collections', i];
  const set = (k: string, v: unknown) => edit.set([...at, k], v);
  const seo = c.seo ?? {};
  return (
    <details open={open || undefined} className="panel group">
      <summary className="flex cursor-pointer items-center gap-3 px-5 py-3">
        <span className="font-semibold">{c.label || c.name || t('New collection')}</span>
        <span className="truncate font-mono text-[12px] text-muted">{c.folder}</span>
      </summary>
      <div className="flex flex-col gap-5 border-t border-line p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Text label={t('Name')} value={c.name} placeholder="posts" onChange={(v) => set('name', v)} />
          <Text label={t('Label')} value={c.label} placeholder={t('Articles')} onChange={(v) => set('label', v)} />
          <Text label={t('Folder')} value={c.folder} placeholder="content/posts" onChange={(v) => set('folder', v)} />
          <Text label={t('Extension')} value={c.extension} placeholder="md" onChange={(v) => set('extension', v)} />
          <Text label={t('File name')} value={c.slug} placeholder="{{slug}}" onChange={(v) => set('slug', v)} />
          <Select label={t('Title field')} value={c.identifier_field} onChange={(v) => set('identifier_field', v)} options={fieldNames(c.fields)} />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Check label={t('New entries allowed')} checked={c.create !== false} onChange={(v) => set('create', v ? undefined : false)} />
          <Check label={t('Translated')} checked={!!c.i18n} onChange={(v) => set('i18n', v || undefined)} />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-[13px] font-semibold">{t('Fields')}</h3>
          <Fields edit={edit} path={[...at, 'fields']} fields={c.fields} cfg={cfg} translated={!!c.i18n} />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-[13px] font-semibold">{t('SEO')}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {(['title', 'description', 'keywords', 'image'] as const).map((k) => (
              <Select key={k} label={t(k === 'title' ? 'Title' : k === 'description' ? 'Description' : k === 'keywords' ? 'Keywords' : 'Image')} value={seo[k] as string} onChange={(v) => edit.set([...at, 'seo', k], v)} options={fieldNames(c.fields)} />
            ))}
          </div>
          <Check label={t('Focus keyword in the URL')} checked={!!seo.slug} onChange={(v) => edit.set([...at, 'seo', 'slug'], v || undefined)} />
        </div>
        <div className="flex justify-end gap-1">
          <Arrows edit={edit} path={['collections']} i={i} n={n} />
          <button type="button" className="btn btn-danger" onClick={() => edit.del(at)}>
            {t('Delete the collection')}
          </button>
        </div>
      </div>
    </details>
  );
}

// ConfigForm edits sumigo.yml as a form. It changes doc in place and calls onChange after each edit.
export default function ConfigForm({ doc, onChange }: { doc: Document; onChange: () => void }) {
  const edit = editor(doc, onChange);
  const [added, setAdded] = useState(-1);
  const cfg = (doc.toJS() ?? {}) as Config;
  const cols = cfg.collections ?? [];
  const i18n = cfg.i18n;

  return (
    <div className="flex flex-col gap-5">
      <Section title={t('Media')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Text label={t('Repository folder')} value={cfg.media_folder} placeholder="static/images" onChange={(v) => edit.set(['media_folder'], v)} />
          <Text label={t('Public URL')} value={cfg.public_folder} placeholder="/images" onChange={(v) => edit.set(['public_folder'], v)} />
        </div>
      </Section>
      <Section title={t('Languages')} actions={<Check label={t('Enabled')} checked={!!i18n} onChange={(v) => edit.set(['i18n'], v ? { locales: [lang] } : undefined)} />}>
        {i18n && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <List label={t('Locales')} value={i18n.locales} placeholder="en, fr" onChange={(v) => edit.set(['i18n', 'locales'], v)} />
            <Select label={t('Default locale')} value={i18n.default_locale} onChange={(v) => edit.set(['i18n', 'default_locale'], v)} options={[['', '-'], ...(i18n.locales ?? []).map((l): [string, string] => [l, l])]} />
            <Select
              label={t('Files')}
              value={i18n.structure}
              onChange={(v) => edit.set(['i18n', 'structure'], v)}
              options={[
                ['', 'posts/fr/hello.md'],
                ['multiple_files', 'posts/hello.fr.md'],
              ]}
            />
          </div>
        )}
      </Section>
      <div className="flex items-center justify-between gap-3">
        <h2>{t('Collections')}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setAdded(cols.length);
            edit.push(['collections'], { name: '', folder: '', fields: [{ name: 'title', label: 'Title', widget: 'string' }] });
          }}
        >
          {t('Add a collection')}
        </button>
      </div>
      {cols.map((c, i) => (
        <CollectionForm key={i} edit={edit} c={c} i={i} n={cols.length} cfg={cfg} open={i === added} />
      ))}
    </div>
  );
}
