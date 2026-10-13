import { FormEvent, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, Route, Routes, useOutletContext } from 'react-router-dom';
import { api, HttpError, Site, User } from './api';
import { CollectionView, PullsView, SiteHome, SiteLayout } from './Site';
import Editor from './Editor';
import { SiteForm, Users } from './Admin';

export interface Ctx {
  me: User;
  sites: Site[];
  reloadSites: () => void;
}

export const useCtx = () => useOutletContext<Ctx>();

export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [sites, setSites] = useState<Site[]>([]);

  const reloadSites = useCallback(() => {
    api<Site[]>('GET', '/sites').then(setSites).catch(() => setSites([]));
  }, []);

  useEffect(() => {
    api<User>('GET', '/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    if (me) reloadSites();
  }, [me, reloadSites]);

  if (me === undefined) return null;
  if (me === null) return <Login onLogin={setMe} />;

  return (
    <Routes>
      <Route element={<Layout me={me} sites={sites} reloadSites={reloadSites} onLogout={() => setMe(null)} />}>
        <Route index element={<Home />} />
        <Route path="sites/:siteId" element={<SiteLayout />}>
          <Route index element={<SiteHome />} />
          <Route path="pulls" element={<PullsView />} />
          <Route path="c/:col" element={<CollectionView />} />
          <Route path="c/:col/new" element={<Editor />} />
          <Route path="c/:col/e/:slug" element={<Editor />} />
        </Route>
        {me.is_admin && (
          <>
            <Route path="admin/users" element={<Users />} />
            <Route path="admin/sites/new" element={<SiteForm />} />
            <Route path="admin/sites/:siteId" element={<SiteForm />} />
          </>
        )}
        <Route path="*" element={<p className="muted">Page not found.</p>} />
      </Route>
    </Routes>
  );
}

function Layout({ me, sites, reloadSites, onLogout }: Ctx & { onLogout: () => void }) {
  const logout = async () => {
    await api('POST', '/logout');
    onLogout();
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          ArticleCMS
        </NavLink>
        <div className="nav-title">Sites</div>
        {sites.map((s) => (
          <NavLink key={s.id} to={`/sites/${s.id}`} className="nav-link">
            {s.name}
          </NavLink>
        ))}
        {sites.length === 0 && <p className="muted small">No site yet.</p>}
        {me.is_admin && (
          <>
            <div className="nav-title">Admin</div>
            <NavLink to="/admin/sites/new" className="nav-link">
              + New site
            </NavLink>
            <NavLink to="/admin/users" className="nav-link">
              Users
            </NavLink>
          </>
        )}
        <div className="sidebar-foot">
          <div className="small">{me.name}</div>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet context={{ me, sites, reloadSites } satisfies Ctx} />
      </main>
    </div>
  );
}

function Home() {
  const { me, sites } = useCtx();
  return (
    <>
      <h1>Hello {me.name}</h1>
      <p className="muted">
        {sites.length ? 'Pick a site in the sidebar to manage its articles.' : me.is_admin ? 'Create your first site.' : 'Ask an admin to give you access to a site.'}
      </p>
    </>
  );
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onLogin(await api<User>('POST', '/login', { email, password }));
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'Login failed');
    }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>ArticleCMS</h1>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary">Log in</button>
    </form>
  );
}
