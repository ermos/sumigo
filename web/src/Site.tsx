import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { api, can, EntrySummary, Pull, SiteDetail } from './api';
import { Ctx, useCtx } from './App';

type SiteCtx = Ctx & { site: SiteDetail };

export const useSite = () => useOutletContext<SiteCtx>().site;

// SiteLayout loads the site and its sumigo.yml once for every page below it.
export function SiteLayout() {
  const { siteId } = useParams();
  const ctx = useCtx();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSite(null);
    setError('');
    api<SiteDetail>('GET', `/sites/${siteId}`)
      .then(setSite)
      .catch((e) => setError(e.message));
  }, [siteId, ctx.sites]);

  if (error) return <p className="error">{error}</p>;
  if (!site) return <p className="muted">Loading…</p>;
  return (
    <>
      <header className="site-header">
        <h1>{site.name}</h1>
        <div className="muted small">
          {site.repo} · {site.branch} · {site.workflow === 'pr' ? 'review via pull requests' : 'direct commits'} · you are {site.role}
        </div>
        <nav className="tabs">
          {site.config?.collections.map((c) => (
            <NavLink key={c.name} to={`/sites/${site.id}/c/${c.name}`}>
              {c.label || c.name}
            </NavLink>
          ))}
          {site.workflow === 'pr' && <NavLink to={`/sites/${site.id}/pulls`}>Pending reviews</NavLink>}
          {ctx.me.is_admin && <NavLink to={`/admin/sites/${site.id}`}>Settings</NavLink>}
        </nav>
        {site.config_error && <p className="error">Cannot load config: {site.config_error}</p>}
      </header>
      <Outlet context={{ ...ctx, site } satisfies SiteCtx} />
    </>
  );
}

export function SiteHome() {
  const site = useSite();
  if (site.config && site.config.collections.length === 0) return <p className="muted">No folder collection in sumigo.yml.</p>;
  return site.config ? <p className="muted">Pick a collection.</p> : null;
}

const formatDate = (d?: string) => {
  const t = d ? Date.parse(d) : NaN;
  return isNaN(t) ? d ?? '' : new Date(t).toLocaleDateString();
};

export function CollectionView() {
  const site = useSite();
  const { col } = useParams();
  const [entries, setEntries] = useState<EntrySummary[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const collection = site.config?.collections.find((c) => c.name === col);

  useEffect(() => {
    setEntries(null);
    setError('');
    api<EntrySummary[]>('GET', `/sites/${site.id}/collections/${col}/entries`)
      .then((e) => setEntries(e.sort((a, b) => String(b.date ?? b.slug).localeCompare(String(a.date ?? a.slug)))))
      .catch((e) => setError(e.message));
  }, [site.id, col]);

  if (!collection) return <p className="muted">Unknown collection.</p>;
  const q = filter.toLowerCase();
  const shown = entries?.filter((e) => e.title.toLowerCase().includes(q) || e.slug.includes(q));
  return (
    <>
      <div className="toolbar">
        <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {can(site.role, 'editor') && collection.create !== false && (
          <Link className="button primary" to={`/sites/${site.id}/c/${col}/new`}>
            New {collection.label || collection.name}
          </Link>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!entries && !error && <p className="muted">Loading entries from GitHub…</p>}
      <ul className="list">
        {shown?.map((e) => (
          <li key={e.slug}>
            <Link to={`/sites/${site.id}/c/${col}/e/${encodeURIComponent(e.slug)}`}>{e.title}</Link>
            {e.draft && <span className="badge">draft #{e.draft.number}</span>}
            <span className="spacer" />
            <span className="muted small">{formatDate(e.date)}</span>
          </li>
        ))}
        {shown?.length === 0 && <li className="muted">No entries.</li>}
      </ul>
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

  const merge = async (p: Pull) => {
    if (!confirm(`Publish "${p.title}"? This squash-merges the pull request.`)) return;
    try {
      await api('POST', `/sites/${site.id}/pulls/${p.number}/merge`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {pulls?.map((p) => {
          const [, col, slug] = p.head.ref.split('/');
          return (
            <li key={p.number}>
              <Link to={`/sites/${site.id}/c/${col}/e/${encodeURIComponent(slug)}`}>{p.title}</Link>
              <span className="muted small">
                #{p.number} · {new Date(p.updated_at).toLocaleString()}
              </span>
              <span className="spacer" />
              <a href={p.html_url} target="_blank" rel="noreferrer">
                GitHub
              </a>
              {can(site.role, 'publisher') && (
                <button className="primary" onClick={() => merge(p)}>
                  Publish
                </button>
              )}
            </li>
          );
        })}
        {pulls?.length === 0 && <li className="muted">Nothing waiting for review.</li>}
      </ul>
    </>
  );
}
