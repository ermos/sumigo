import { ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { api, can, EntrySummary, MediaFile, mediaSrc, Pull, SiteDetail, uploadMedia } from './api';
import { Ctx, useCtx } from './App';

import { useCached } from './cache';
import { Pending, Spinner, useAction } from './ui';

export const entriesKey = (siteId: number, col?: string) => `entries:${siteId}:${col}`;

type SiteCtx = Ctx & { site: SiteDetail };

export const useSite = () => useOutletContext<SiteCtx>().site;

export const Notice = ({ tone = 'danger', children }: { tone?: 'danger' | 'ok'; children: ReactNode }) => (
  <p className={`rounded-md border px-3 py-2 text-[13px] ${tone === 'ok' ? 'border-ok/30 bg-ok/5 text-ok' : 'border-danger/30 bg-danger/5 text-danger'}`}>{children}</p>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-8 text-center text-[13px] text-muted">{children}</p>;

export const Loading = ({ children = 'Loading…' }: { children?: ReactNode }) => (
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

  if (!site) return error ? <Notice>{error}</Notice> : <Loading />;
  return (
    <>
      {site.config_error && (
        <div className="mb-4">
          <Notice>Cannot load sumigo.yml: {site.config_error}</Notice>
        </div>
      )}
      <Outlet context={{ ...ctx, site } satisfies SiteCtx} />
    </>
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
          <p className="px-2.5 pb-1 text-xs font-medium text-muted">Collections</p>
          {site.config?.collections.map((c) => (
            <NavLink key={c.name} to={`/sites/${site.id}/c/${c.name}`} className={sideLink}>
              {c.label || c.name}
            </NavLink>
          ))}
          {me.is_admin && (
            <>
              <span className="my-2 h-px bg-line" />
              <NavLink to={`/admin/sites/${site.id}/members`} className={sideLink}>
                Members
              </NavLink>
              <NavLink to={`/admin/sites/${site.id}`} end className={sideLink}>
                Settings
              </NavLink>
            </>
          )}
        </nav>
        <p className="mt-6 hidden px-2.5 text-xs leading-5 text-muted md:block">
          <a href={`https://github.com/${site.repo}/tree/${site.branch}`} target="_blank" rel="noreferrer" className="font-mono hover:text-accent">
            {site.repo}@{site.branch}
          </a>
          <br />
          {site.workflow === 'pr' ? 'Only publishers can publish.' : 'Editors can publish.'}
        </p>
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
  return first ? <Navigate to={`/sites/${site.id}/c/${first.name}`} replace /> : <Empty>sumigo.yml declares no folder collection.</Empty>;
}

export const formatDate = (d?: string) => {
  const t = d ? Date.parse(d) : NaN;
  return isNaN(t) ? (d ?? '') : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const DraftPill = ({ pull }: { pull: Pull }) => <span className="pill bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/25">Draft #{pull.number}</span>;

export function CollectionView() {
  const site = useSite();
  const { col } = useParams();
  const [filter, setFilter] = useState('');
  const collection = site.config?.collections.find((c) => c.name === col);
  const {
    data: entries,
    error,
    refreshing,
  } = useCached(entriesKey(site.id, col), () =>
    api<EntrySummary[]>('GET', `/sites/${site.id}/collections/${col}/entries`).then((e) => e.sort((a, b) => String(b.date ?? b.slug).localeCompare(String(a.date ?? a.slug)))),
  );

  if (!collection) return <Empty>Unknown collection.</Empty>;
  const q = filter.toLowerCase();
  const shown = entries?.filter((e) => e.title.toLowerCase().includes(q) || e.slug.includes(q));
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto">
          {collection.label || collection.name}
          {entries && <span className="ml-2 text-base font-normal text-muted">{entries.length}</span>}
          {entries && refreshing && <span className="ml-3 text-xs font-normal text-muted">Syncing with GitHub…</span>}
        </h1>
        <input className="field w-56" type="search" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {can(site.role, 'editor') && collection.create !== false && (
          <Link className="btn btn-primary" to={`/sites/${site.id}/c/${col}/new`}>
            New entry
          </Link>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {!entries && !error && <Loading>Loading entries from GitHub…</Loading>}
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
      {shown?.length === 0 && <Empty>{filter ? 'No entry matches this search.' : 'No entries yet.'}</Empty>}
    </>
  );
}

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
  const merge = (p: Pull) =>
    confirm(`Publish "${p.title}"? This squash-merges the pull request.`) &&
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
      <div className="mb-5">
        <h1>Workflow</h1>
        <p className="text-muted">Drafts waiting to be published. Each one is a pull request on GitHub.</p>
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
                  #{p.number} by {p.user.login}, updated {new Date(p.updated_at).toLocaleString()}
                </div>
              </div>
              <a className="btn" href={p.html_url} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
              {can(site.role, site.workflow === 'pr' ? 'publisher' : 'editor') && (
                <button className="btn btn-primary" onClick={() => merge(p)} disabled={!!pending}>
                  <Pending on={pending === String(p.number)}>{pending === String(p.number) ? 'Publishing…' : 'Publish'}</Pending>
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
            <Empty>No draft. Use Save draft in the editor to keep changes without publishing them.</Empty>
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
  const remove = (f: MediaFile) =>
    confirm(`Delete ${f.name}?${f.used ? ' An entry still uses it, the image will break there.' : ''} This commits the deletion.`) &&
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
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto">
          Media
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
                {v ? `Unused ${files.filter((f) => !f.used).length}` : 'All'}
              </button>
            ))}
          </div>
        )}
        {can(site.role, 'editor') && site.config?.media_folder && (
          <label className="btn btn-primary relative cursor-pointer">
            <Pending on={busy}>{busy ? 'Uploading…' : 'Upload'}</Pending>
            <input type="file" multiple disabled={busy} className="absolute inset-0 cursor-pointer opacity-0" onChange={(e) => upload(e.target.files)} />
          </label>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {site.config && !site.config.media_folder && <Empty>Set media_folder in sumigo.yml to store media.</Empty>}
      {!files && !error && <Loading />}
      {files?.length === 0 && site.config?.media_folder && <Empty>No media yet. Upload images here, or paste them into an article.</Empty>}
      {onlyUnused && files?.every((f) => f.used) && <Empty>Every file is used by an entry.</Empty>}
      {files && files.length > 0 && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {files
            .filter((f) => !onlyUnused || !f.used)
            .map((f) => (
              <li key={f.name} className={`panel overflow-hidden transition-opacity ${deleting === f.name ? 'pointer-events-none opacity-50' : ''}`}>
                <div className="relative grid aspect-[4/3] place-items-center bg-canvas">
                  {!f.used && (
                    <span className="pill absolute top-2 left-2 bg-surface/90 text-muted ring-1 ring-line" title="No entry, published or draft, mentions this file. Templates are not checked.">
                      Unused
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
                      {copied === f.url ? 'Copied' : 'Copy URL'}
                    </button>
                    {can(site.role, 'publisher') && (
                      <button type="button" className="flex items-center gap-1 text-xs font-medium text-danger hover:underline disabled:no-underline" onClick={() => remove(f)} disabled={!!deleting}>
                        <Pending on={deleting === f.name}>{deleting === f.name ? 'Deleting…' : 'Delete'}</Pending>
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
