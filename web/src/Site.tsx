import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useMatch, useOutletContext, useParams } from 'react-router-dom';
import { api, can, EntrySummary, Field, forgeNames, MediaFile, mediaSrc, Pull, SiteDetail, uploadMedia } from './api';
import { Ctx, useCtx } from './App';

import { setCached, useCached } from './cache';
import { applyView, cell, defaultView, listable, pageSizes, text, View } from './listview';
import { Icon, icons, Pending, Spinner, useAction, useConfirm } from './ui';
import { lang, t } from './i18n';

// fetchEntries loads a collection, newest first. Shared by its list and the relation fields pointing to it, which share the cache.
export const fetchEntries = (siteId: number, col: string) =>
  api<EntrySummary[]>('GET', `/sites/${siteId}/collections/${col}/entries`).then((e) => e.sort((a, b) => String(b.date ?? b.slug).localeCompare(String(a.date ?? a.slug))));

export const entriesKey = (siteId: number, col?: string) => `entries:${siteId}:${col}`;

export type SiteCtx = Ctx & { site: SiteDetail };

export const useSite = () => useOutletContext<SiteCtx>().site;

export const Notice = ({ tone = 'danger', children }: { tone?: 'danger' | 'ok'; children: ReactNode }) => (
  <p className={`rounded-md border px-3 py-2 text-[13px] ${tone === 'ok' ? 'border-ok/30 bg-ok/5 text-ok' : 'border-danger/30 bg-danger/5 text-danger'}`}>{children}</p>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-8 text-center text-[13px] text-muted">{children}</p>;

export const Loading = ({ children = t('Loading…') }: { children?: ReactNode }) => (
  <p className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted" role="status">
    <Spinner className="size-4 text-accent" />
    {children}
  </p>
);

const sideLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${isActive ? 'bg-surface font-medium text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'}`;

// SiteLayout loads the site and its sumigo.yml once for every page below it.
export function SiteLayout() {
  const { siteId } = useParams();
  const ctx = useCtx();
  const { data: site, error } = useCached(`site:${siteId}`, () => api<SiteDetail>('GET', `/sites/${siteId}`), [ctx.sites]);
  const onSetup = useMatch('/sites/:siteId/setup');

  if (!site) return error ? <Notice>{error}</Notice> : <Loading />;
  return (
    <>
      {site.config_missing && !onSetup && (
        <div className="panel mb-4 flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
          <span className="flex-1">{t(ctx.me.is_admin ? 'This repository has no sumigo.yml yet.' : 'This site is not set up yet. Ask an admin.')}</span>
          {ctx.me.is_admin && (
            <Link to={`/sites/${site.id}/setup`} className="btn btn-primary">
              {t('Set up the site')}
            </Link>
          )}
        </div>
      )}
      {site.config_error && !site.config_missing && (
        <div className="mb-4">
          <Notice>{t('Cannot load sumigo.yml: {error}', { error: site.config_error })}</Notice>
        </div>
      )}
      <Outlet context={{ ...ctx, site } satisfies SiteCtx} />
    </>
  );
}

// PageHeader is the title row of a page next to a sidebar: 38px high, like the sidebar heading, so both line up.
export const PageHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="mb-5 flex min-h-[38px] flex-wrap items-center gap-3">
    <h1 className="mr-auto">{title}</h1>
    {children}
  </div>
);

// SettingsLayout lays the site settings out like the collections: sub-pages in a sidebar. Admins only.
export function SettingsLayout() {
  const ctx = useOutletContext<SiteCtx>();
  const { site, me } = ctx;
  if (!me.is_admin) return <Navigate to={`/sites/${site.id}`} replace />;
  const base = `/sites/${site.id}/settings`;
  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <aside className="shrink-0 md:w-52">
        <nav className="flex flex-col gap-0.5">
          <p className="mb-5 flex h-[38px] items-center px-2.5 text-2xl font-semibold tracking-tight">{t('Settings')}</p>
          <NavLink to={base} end className={sideLink}>
            {t('General')}
          </NavLink>
          <NavLink to={`${base}/domains`} className={sideLink}>
            {t('Domains')}
          </NavLink>
          <NavLink to={`${base}/members`} className={sideLink}>
            {t('Members')}
          </NavLink>
          <NavLink to={`${base}/config`} className={sideLink}>
            sumigo.yml
          </NavLink>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}

// ContentLayout lists the collections next to the entries, like Decap.
export function ContentLayout() {
  const ctx = useOutletContext<SiteCtx>();
  const { site, me } = ctx;
  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <aside className="shrink-0 md:w-52">
        <nav className="flex flex-col gap-0.5">
          {/* Same size and row height (38px, like the search field) as the collection title, so both line up. */}
          <p className="mb-5 flex h-[38px] items-center px-2.5 text-2xl font-semibold tracking-tight">{t('Collections')}</p>
          {site.config?.collections.map((c) => (
            <NavLink key={c.name} to={`/sites/${site.id}/c/${c.name}`} className={sideLink}>
              {c.label || c.name}
            </NavLink>
          ))}
          {me.is_admin && (
            <>
              <span className="my-2 h-px bg-line" />
              <NavLink to={`/sites/${site.id}/settings`} className={sideLink}>
                {t('Settings')}
              </NavLink>
            </>
          )}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}

// SiteHome opens the first collection, like Decap does.
export function SiteHome() {
  const site = useSite();
  if (!site.config) return null;
  const first = site.config.collections[0];
  return first ? <Navigate to={`/sites/${site.id}/c/${first.name}`} replace /> : <Empty>{t('sumigo.yml declares no folder collection.')}</Empty>;
}

export const formatDate = (d?: string) => {
  const t = d ? Date.parse(d) : NaN;
  return isNaN(t)
    ? (d ?? '')
    : new Date(t).toLocaleDateString(lang, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
};

export const formatDateTime = (d: string) => new Date(d).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// DraftPill marks an entry with unpublished changes, and when they go live on their own.
export const DraftPill = ({ pull }: { pull: Pull }) =>
  pull.scheduled_at ? (
    <span className="pill bg-accent-soft text-accent ring-1 ring-accent/25">{t('Scheduled {date}', { date: formatDateTime(pull.scheduled_at) })}</span>
  ) : (
    <span className="pill bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/25">{t('Draft #{n}', { n: pull.number })}</span>
  );

export function CollectionView() {
  const site = useSite();
  const { col } = useParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const panel = useRef<HTMLDialogElement>(null);
  const collection = site.config?.collections.find((c) => c.name === col);
  const { data: entries, error } = useCached(entriesKey(site.id, col), () => fetchEntries(site.id, col!));
  const viewKey = `view:${site.id}:${col}`;
  const { data: saved } = useCached(viewKey, () => api<Partial<View> | null>('GET', `/sites/${site.id}/collections/${col}/view`));
  const [edited, setEdited] = useState<{ col?: string; view: View }>();
  const timer = useRef(0);

  if (!collection) return <Empty>{t('Unknown collection.')}</Empty>;
  const fields = listable(collection);
  const view: View = edited && edited.col === col ? edited.view : { ...defaultView(collection), ...saved };
  // ponytail: columns follow the field order of sumigo.yml, drag to reorder if users ask for it.
  const columns = fields.filter((f) => view.columns.includes(f.name) && f.name !== collection.identifier_field && f.name !== 'title');
  const update = (patch: Partial<View>) => {
    const v = { ...view, ...patch };
    setEdited({ col, view: v });
    setCached(viewKey, v);
    setPage(0);
    clearTimeout(timer.current);
    // Saved once the user stops typing, not on every key of a filter.
    timer.current = window.setTimeout(() => api('PUT', `/sites/${site.id}/collections/${col}/view`, v).catch(() => {}), 600);
  };

  const shown = entries && applyView(entries, view, search);
  const pages = Math.max(1, Math.ceil((shown?.length ?? 0) / view.pageSize));
  const current = Math.min(page, pages - 1);
  const rows = shown?.slice(current * view.pageSize, (current + 1) * view.pageSize);
  const active = view.filters.filter((f) => f.value).length;
  const translated = collection.i18n && (collection.locales?.length ?? 0) > 1;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto">{collection.label || collection.name}</h1>
        <input
          className="field w-56"
          type="search"
          placeholder={t('Search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <button type="button" className="btn relative px-2" onClick={() => panel.current?.showModal()} aria-label={t('Display')} title={t('Display')}>
          <Icon d={icons.sliders} />
          {active > 0 && <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-accent text-[10px] font-semibold text-white">{active}</span>}
        </button>
        {can(site.role, 'editor') && collection.create !== false && (
          <Link className="btn btn-primary" to={`/sites/${site.id}/c/${col}/new`}>
            {t('New entry')}
          </Link>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {!entries && !error && <EntriesPlaceholder />}
      {rows && rows.length > 0 && (
        <ul className="panel divide-y divide-line">
          {rows.map((e) => (
            <li key={e.slug}>
              <Link to={`/sites/${site.id}/c/${col}/e/${encodeURIComponent(e.slug)}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-canvas/60">
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{e.title}</span>
                {e.draft && <DraftPill pull={e.draft} />}
                {translated && (
                  <span className="hidden gap-1.5 font-mono text-[11px] font-medium uppercase sm:flex">
                    {collection.locales!.map((l) =>
                      e.locales?.includes(l) ? (
                        <span key={l}>{l}</span>
                      ) : (
                        <span key={l} className="text-muted/50" title={t('Missing translation')}>
                          {l}
                        </span>
                      ),
                    )}
                  </span>
                )}
                {columns.map((f) => (
                  <span key={f.name} className="hidden w-32 shrink-0 truncate text-right text-[13px] text-muted tabular-nums sm:block" title={f.label || f.name}>
                    <Cell field={f} value={cell(e, f.name)} />
                  </span>
                ))}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shown && shown.length > view.pageSize && (
        <nav className="mt-4 flex items-center justify-end gap-2 text-[13px] text-muted" aria-label={t('Pagination')}>
          <span className="mr-2 tabular-nums">
            {t('{from}–{to} of {total}', {
              from: current * view.pageSize + 1,
              to: current * view.pageSize + rows!.length,
              total: shown.length,
            })}
          </span>
          <button type="button" className="btn px-1.5" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={t('Previous page')}>
            <Icon d={icons.left} />
          </button>
          <button type="button" className="btn px-1.5" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label={t('Next page')}>
            <Icon d={icons.right} />
          </button>
        </nav>
      )}
      {shown?.length === 0 && <Empty>{t(search || active ? 'No entry matches this search.' : 'No entries yet.')}</Empty>}
      <dialog
        ref={panel}
        onClick={(e) => e.target === panel.current && panel.current.close()}
        className="drawer m-0 ml-auto h-dvh max-h-none w-full max-w-[380px] border-l border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-ink/25 backdrop:backdrop-blur-[2px]"
      >
        <div className="flex h-full flex-col">
          <header className="flex items-center gap-3 border-b border-line px-5 py-4">
            <span className="grid size-8 place-items-center rounded-md bg-accent-soft text-accent">
              <Icon d={icons.sliders} />
            </span>
            <h2 className="mr-auto">{t('Display')}</h2>
            <button type="button" className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink" onClick={() => panel.current?.close()} aria-label={t('Close')}>
              <Icon d={icons.x} />
            </button>
          </header>
          <div className="flex-1 divide-y divide-line overflow-y-auto px-5">
            <Section icon={icons.columns} title={t('Columns')}>
              <div className="flex flex-wrap gap-1.5">
                {fields
                  .filter((f) => f.name !== 'title' && f.name !== collection.identifier_field)
                  .map((f) => {
                    const on = view.columns.includes(f.name);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => update({ columns: on ? view.columns.filter((c) => c !== f.name) : [...view.columns, f.name] })}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-medium ring-1 transition-colors ${on ? 'bg-accent-soft text-accent ring-accent/30' : 'text-muted ring-line hover:text-ink hover:ring-ink/20'}`}
                      >
                        {on && <Icon d={icons.check} size="size-3.5" />}
                        {f.label || f.name}
                      </button>
                    );
                  })}
              </div>
            </Section>
            <Section icon={icons.sort} title={t('Sort by')}>
              <select className="field" value={view.sort.field} onChange={(e) => update({ sort: { ...view.sort, field: e.target.value } })} aria-label={t('Sort by')}>
                {!fields.some((f) => f.name === 'title') && <option value="title">{t('Title')}</option>}
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label || f.name}
                  </option>
                ))}
              </select>
              <Segmented
                label={t('Order')}
                value={view.sort.desc}
                onChange={(desc) => update({ sort: { ...view.sort, desc } })}
                options={[
                  { value: false, label: t('Ascending'), icon: icons.up },
                  { value: true, label: t('Descending'), icon: icons.down },
                ]}
              />
            </Section>
            <Section icon={icons.filter} title={t('Filters')} count={active}>
              {view.filters.map((f, i) => {
                const field = fields.find((x) => x.name === f.field);
                const set = (patch: Partial<View['filters'][number]>) => update({ filters: view.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="flex flex-col gap-2 rounded-lg bg-canvas p-2.5 ring-1 ring-line">
                    <div className="flex items-center gap-2">
                      <select className="field py-1 text-[13px]" value={f.field} onChange={(e) => set({ field: e.target.value, value: '' })} aria-label={t('Field')}>
                        {fields.map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.label || x.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                        onClick={() => update({ filters: view.filters.filter((_, j) => j !== i) })}
                        aria-label={t('Remove filter')}
                      >
                        <Icon d={icons.x} size="size-3.5" />
                      </button>
                    </div>
                    {field?.widget === 'boolean' || field?.options ? (
                      <select className="field" value={f.value} onChange={(e) => set({ value: e.target.value })} aria-label={t('Value')}>
                        <option value="" />
                        {(field.options ?? ['true', 'false']).map((o) => {
                          const [value, label] = typeof o === 'string' ? [o, o] : [o.value, o.label];
                          return (
                            <option key={value} value={value}>
                              {field.widget === 'boolean' ? t(value === 'true' ? 'Yes' : 'No') : label}
                            </option>
                          );
                        })}
                      </select>
                    ) : (
                      <input className="field" value={f.value} placeholder={t('Contains…')} onChange={(e) => set({ value: e.target.value })} aria-label={t('Value')} />
                    )}
                  </div>
                );
              })}
              {fields.length > 0 && (
                <button
                  type="button"
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-line py-2 text-[13px] font-medium text-muted transition-colors hover:border-accent/50 hover:bg-accent-soft/50 hover:text-accent"
                  onClick={() => update({ filters: [...view.filters, { field: fields[0].name, value: '' }] })}
                >
                  <Icon d={icons.plus} size="size-3.5" />
                  {t('Add filter')}
                </button>
              )}
            </Section>
            <Section icon={icons.ul} title={t('Per page')}>
              <Segmented label={t('Per page')} value={view.pageSize} onChange={(pageSize) => update({ pageSize })} options={pageSizes.map((n) => ({ value: n, label: String(n) }))} />
            </Section>
          </div>
          <footer className="flex items-center justify-between gap-2 border-t border-line bg-canvas/60 px-5 py-3.5">
            <button type="button" className="btn border-transparent bg-transparent text-muted shadow-none hover:text-ink" onClick={() => update(defaultView(collection))}>
              <Icon d={icons.reset} size="size-3.5" />
              {t('Reset')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => panel.current?.close()}>
              {t('Done')}
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}

// Section is a block of the display panel: a small caps title over its controls.
const Section = ({ icon, title, count = 0, children }: { icon: string; title: string; count?: number; children: ReactNode }) => (
  <section className="flex flex-col gap-3 py-5">
    <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
      <Icon d={icon} size="size-3.5" />
      {title}
      {count > 0 && <span className="pill bg-accent-soft px-1.5 py-0 text-accent">{count}</span>}
    </h3>
    {children}
  </section>
);

// Segmented picks one of a few values, like the active link of the sidebar.
function Segmented<T>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-canvas p-0.5 ring-1 ring-line">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-3 py-1 text-[13px] font-medium transition-colors ${o.value === value ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'}`}
        >
          {o.icon && <Icon d={o.icon} size="size-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Cell shows a field value in a row: dates formatted, images as a thumbnail, lists joined.
function Cell({ field, value }: { field: Field; value: unknown }) {
  const site = useSite();
  if (value == null || value === '') return null;
  if (field.widget === 'date' || field.widget === 'datetime') return <>{formatDate(String(value))}</>;
  if (field.widget === 'boolean') return <>{t(value ? 'Yes' : 'No')}</>;
  if (field.widget === 'image') return <img src={mediaSrc(site, String(value))} alt="" className="ml-auto size-7 rounded object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />;
  const label = field.options?.find((o) => typeof o !== 'string' && o.value === value);
  return <>{label && typeof label !== 'string' ? label.label : text(value)}</>;
}

// EntriesPlaceholder mimics the entry list while it loads: same rows, grey bars instead of text.
const placeholderWidths = ['w-3/5', 'w-2/5', 'w-1/2', 'w-2/3', 'w-1/3', 'w-1/2'];
const EntriesPlaceholder = () => (
  <ul className="panel divide-y divide-line" aria-busy="true" aria-label={t('Loading…')}>
    {placeholderWidths.map((w, i) => (
      <li key={i} className="flex h-[52px] items-center gap-3 px-5 motion-safe:animate-pulse">
        <span className="flex-1">
          <span className={`block h-3.5 rounded bg-line ${w}`} />
        </span>
        <span className="h-3 w-20 rounded bg-line" />
      </li>
    ))}
  </ul>
);

export function PullsView() {
  const site = useSite();
  const [pulls, setPulls] = useState<Pull[] | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    api<Pull[]>('GET', `/sites/${site.id}/pulls`)
      .then(setPulls)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [site.id]);

  const [run, pending] = useAction();
  const [ask, confirmDialog] = useConfirm();
  const merge = async (p: Pull) =>
    (await ask({ title: t('Publish "{title}"? This squash-merges the pull request.', { title: p.title }), action: t('Publish') })) &&
    run(String(p.number), async () => {
      try {
        await api('POST', `/sites/${site.id}/pulls/${p.number}/merge`);
        setPulls((list) => list?.filter((x) => x.number !== p.number) ?? null);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <>
      {confirmDialog}
      <div className="mb-5">
        <h1>{t('Workflow')}</h1>
        <p className="text-muted">{t('Drafts waiting to be published. Each one is a pull request on {forge}.', { forge: forgeNames[site.forge] })}</p>
      </div>
      {error && <Notice>{error}</Notice>}
      <ul className="panel divide-y divide-line">
        {pulls?.map((p) => {
          const [, col, slug] = p.head.ref.split('/');
          return (
            <li key={p.number} className={`flex flex-wrap items-center gap-3 px-4 py-3 transition-opacity ${pending === String(p.number) ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <Link to={`/sites/${site.id}/c/${col}/e/${encodeURIComponent(slug)}`} className="font-medium hover:text-accent">
                  {p.title}
                </Link>
                <div className="text-xs text-muted">
                  {t('#{number} by {user}, updated {date}', {
                    number: p.number,
                    user: p.user.login,
                    date: new Date(p.updated_at).toLocaleString(lang),
                  })}
                  {p.scheduled_at && <span className="ml-2 font-medium text-accent">{t('Scheduled {date}', { date: formatDateTime(p.scheduled_at) })}</span>}
                </div>
              </div>
              <a className="btn" href={p.html_url} target="_blank" rel="noreferrer">
                {t('View on {forge}', { forge: forgeNames[site.forge] })}
              </a>
              {can(site.role, site.workflow === 'pr' ? 'publisher' : 'editor') && (
                <button className="btn btn-primary" onClick={() => merge(p)} disabled={!!pending}>
                  <Pending on={pending === String(p.number)}>{t(pending === String(p.number) ? 'Publishing…' : 'Publish')}</Pending>
                </button>
              )}
            </li>
          );
        })}
        {!pulls && !error && (
          <li>
            <Loading />
          </li>
        )}
        {pulls?.length === 0 && (
          <li>
            <Empty>{t('No draft. Use Save draft in the editor to keep changes without publishing them.')}</Empty>
          </li>
        )}
      </ul>
    </>
  );
}

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
const formatSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function MediaView() {
  const site = useSite();
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [onlyUnused, setOnlyUnused] = useState(false);

  const load = () => {
    api<MediaFile[]>('GET', `/sites/${site.id}/media`)
      .then(setFiles)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [site.id]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError('');
    try {
      for (const f of Array.from(list)) await uploadMedia(site.id, f);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [run, deleting] = useAction();
  const [ask, confirmDialog] = useConfirm();
  const remove = async (f: MediaFile) =>
    (await ask({
      title: t('Delete {name}?', { name: f.name }),
      text: `${f.used ? `${t('An entry still uses it, the image will break there.')} ` : ''}${t('This commits the deletion.')}`,
      action: t('Delete'),
      danger: true,
    })) &&
    run(f.name, async () => {
      setError('');
      try {
        await api('DELETE', `/sites/${site.id}/media/${encodeURIComponent(f.name)}`);
        setFiles((list) => list?.filter((x) => x.name !== f.name) ?? null);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(url);
  };

  return (
    <>
      {confirmDialog}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto">
          {t('Media')}
          {files && <span className="ml-2 text-base font-normal text-muted">{files.length}</span>}
        </h1>
        {files && files.length > 0 && (
          <div role="tablist" className="flex rounded-md bg-surface p-0.5 ring-1 ring-line">
            {[false, true].map((v) => (
              <button
                key={String(v)}
                type="button"
                role="tab"
                aria-selected={onlyUnused === v}
                onClick={() => setOnlyUnused(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${onlyUnused === v ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
              >
                {v ? t('Unused {n}', { n: files.filter((f) => !f.used).length }) : t('All')}
              </button>
            ))}
          </div>
        )}
        {can(site.role, 'editor') && site.config?.media_folder && (
          <label className="btn btn-primary relative cursor-pointer">
            <Pending on={busy}>{t(busy ? 'Uploading…' : 'Upload')}</Pending>
            <input type="file" multiple disabled={busy} className="absolute inset-0 cursor-pointer opacity-0" onChange={(e) => upload(e.target.files)} />
          </label>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {site.config && !site.config.media_folder && <Empty>{t('Set media_folder in sumigo.yml to store media.')}</Empty>}
      {!files && !error && <Loading />}
      {files?.length === 0 && site.config?.media_folder && <Empty>{t('No media yet. Upload images here, or paste them into an article.')}</Empty>}
      {onlyUnused && files?.every((f) => f.used) && <Empty>{t('Every file is used by an entry.')}</Empty>}
      {files && files.length > 0 && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {files
            .filter((f) => !onlyUnused || !f.used)
            .map((f) => (
              <li key={f.name} className={`panel overflow-hidden transition-opacity ${deleting === f.name ? 'pointer-events-none opacity-50' : ''}`}>
                <div className="relative grid aspect-[4/3] place-items-center bg-canvas">
                  {!f.used && (
                    <span className="pill absolute top-2 left-2 bg-surface/90 text-muted ring-1 ring-line" title={t('No entry, published or draft, mentions this file. Templates are not checked.')}>
                      {t('Unused')}
                    </span>
                  )}
                  {isImage(f.name) ? (
                    <img src={mediaSrc(site, f.url)} alt="" loading="lazy" className="size-full object-cover" />
                  ) : (
                    <span className="font-mono text-xs text-muted uppercase">{f.name.split('.').pop()}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 border-t border-line px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" title={f.name}>
                      {f.name}
                    </div>
                    <div className="text-xs text-muted">{formatSize(f.size)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => copy(f.url)}>
                      {t(copied === f.url ? 'Copied' : 'Copy URL')}
                    </button>
                    {can(site.role, 'publisher') && (
                      <button type="button" className="flex items-center gap-1 text-xs font-medium text-danger hover:underline disabled:no-underline" onClick={() => remove(f)} disabled={!!deleting}>
                        <Pending on={deleting === f.name}>{t(deleting === f.name ? 'Deleting…' : 'Delete')}</Pending>
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
        </ul>
      )}
    </>
  );
}
