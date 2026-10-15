import { ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useMatch, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, can, EntrySummary, forgeNames, MediaFile, mediaSrc, Pull, SiteDetail, uploadMedia } from './api';
import { Ctx, useCtx } from './App';

import { useCached } from './cache';
import { Pending, Spinner, useAction, useConfirm } from './ui';
import { lang, t } from './i18n';

// fetchEntries loads a collection, newest first. Shared by its list and the relation fields pointing to it, which share the cache.
export const fetchEntries = (siteId: number, col: string) =>
  api<EntrySummary[]>('GET', `/sites/${siteId}/collections/${col}/entries`).then((e) => e.sort((a, b) => String(b.date ?? b.slug).localeCompare(String(a.date ?? a.slug))));

export const entriesKey = (siteId: number, col?: string) => `entries:${siteId}:${col}`;

type SiteCtx = Ctx & { site: SiteDetail };

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

// SetupView drafts the sumigo.yml of a repository (its Decap config, or detected from its files) and commits it once reviewed.
export function SetupView() {
  const { site, reloadSites } = useOutletContext<SiteCtx>();
  const navigate = useNavigate();
  const [run, pending] = useAction();
  const [proposal, setProposal] = useState<{ yaml: string; source: 'decap' | 'detected'; from?: string } | null>(null);
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ yaml: string; source: 'decap' | 'detected'; from?: string }>('GET', `/sites/${site.id}/setup`)
      .then((p) => {
        setProposal(p);
        setYaml(p.yaml);
      })
      .catch((e) => setError(e.message));
  }, [site.id]);

  const apply = async () => {
    setError('');
    try {
      await api('POST', `/sites/${site.id}/setup`, { yaml });
      reloadSites();
      navigate(`/sites/${site.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1>{t('Set up {name}', { name: site.name })}</h1>
      <p className="mb-6 text-muted">
        {proposal && t(proposal.source === 'decap' ? 'Imported from {file}.' : 'Detected from the repository files.', { file: proposal.from ?? '' })}
      </p>
      {!proposal && !error && <Loading>{t('Analyzing the repository…')}</Loading>}
      {proposal && (
        <div className="panel">
          <div className="p-4">
            <textarea className="field min-h-[28rem] w-full font-mono text-xs leading-5" value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} aria-label="sumigo.yml" />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line bg-canvas/60 px-4 py-3">
            <a href="https://ermos.github.io/sumigo/configuration/sumigo-yml" target="_blank" rel="noreferrer" className="mr-auto text-[13px] text-accent hover:underline">
              {t('sumigo.yml reference')}
            </a>
            <button type="button" className="btn btn-primary" onClick={() => run('apply', apply)} disabled={!!pending || !yaml.trim()}>
              <Pending on={!!pending}>{t(pending ? 'Committing…' : 'Create sumigo.yml')}</Pending>
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Notice>{error}</Notice>
        </div>
      )}
    </div>
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
  const [filter, setFilter] = useState('');
  const collection = site.config?.collections.find((c) => c.name === col);
  const { data: entries, error } = useCached(entriesKey(site.id, col), () => fetchEntries(site.id, col!));

  if (!collection) return <Empty>{t('Unknown collection.')}</Empty>;
  const q = filter.toLowerCase();
  const shown = entries?.filter((e) => e.title.toLowerCase().includes(q) || e.slug.includes(q));
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto">{collection.label || collection.name}</h1>
        <input className="field w-56" type="search" placeholder={t('Search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {can(site.role, 'editor') && collection.create !== false && (
          <Link className="btn btn-primary" to={`/sites/${site.id}/c/${col}/new`}>
            {t('New entry')}
          </Link>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {!entries && !error && <EntriesPlaceholder />}
      {shown && shown.length > 0 && (
        <ul className="panel divide-y divide-line">
          {shown.map((e) => (
            <li key={e.slug}>
              <Link to={`/sites/${site.id}/c/${col}/e/${encodeURIComponent(e.slug)}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-canvas/60">
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{e.title}</span>
                {e.draft && <DraftPill pull={e.draft} />}
                <span className="w-28 shrink-0 text-right text-[13px] text-muted tabular-nums">{formatDate(e.date)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shown?.length === 0 && <Empty>{t(filter ? 'No entry matches this search.' : 'No entries yet.')}</Empty>}
    </>
  );
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
