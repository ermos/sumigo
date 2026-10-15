import { FormEvent, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch, useOutletContext } from 'react-router-dom';
import { api, HttpError, Site, User } from './api';
import { clearCache } from './cache';
import { Lang, lang, languages, setLang, t, tError } from './i18n';
import { Pending, ProgressBar, useAction } from './ui';
import { CollectionView, ContentLayout, Loading, MediaView, PullsView, SettingsLayout, SetupView, SiteHome, SiteLayout } from './Site';
import Editor from './Editor';
// The sumigo.yml editor brings CodeMirror: loaded only when opened.
const ConfigEditor = lazy(() => import('./ConfigEditor'));
import { AdminLayout, AdminSites, AISettingsPage, SiteDomains, SiteForm, SiteMembers, SSOSettingsPage, Users } from './Admin';

export interface Ctx {
  me: User;
  sites: Site[];
  reloadSites: () => void;
  // setMe updates the logged in user after they edit their account.
  setMe: (u: User) => void;
}

export const useCtx = () => useOutletContext<Ctx>();

export const roleNames = {
  admin: 'Admin',
  viewer: 'Viewer',
  editor: 'Editor',
  publisher: 'Publisher',
} as const;

export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [sites, setSites] = useState<Site[]>([]);

  const reloadSites = useCallback(() => {
    api<Site[]>('GET', '/sites')
      .then(setSites)
      .catch(() => setSites([]));
  }, []);

  // needsSetup: no user yet, the first account is created with the setup code of the server logs.
  const [needsSetup, setNeedsSetup] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    api<User>('GET', '/me')
      .then(setMe)
      .catch(() => setMe(null));
    api<{ needed: boolean }>('GET', '/setup')
      .then((s) => setNeedsSetup(s.needed))
      .catch(() => setNeedsSetup(false));
  }, []);
  useEffect(() => {
    if (me) reloadSites();
  }, [me, reloadSites]);

  if (me === undefined) return null;
  if (me === null && needsSetup === undefined) return null;
  if (me === null) return needsSetup ? <Setup onDone={setMe} /> : <Login onLogin={setMe} />;
  if (me.must_change_password) return <ChoosePassword me={me} onDone={setMe} onLogout={() => setMe(null)} />;

  return (
    <>
      <ProgressBar />
      <Routes>
        <Route element={<Layout me={me} sites={sites} reloadSites={reloadSites} setMe={setMe} onLogout={() => setMe(null)} />}>
          <Route index element={<Home />} />
          <Route path="account" element={<Account />} />
          <Route path="sites/:siteId" element={<SiteLayout />}>
            <Route element={<ContentLayout />}>
              <Route index element={<SiteHome />} />
              <Route path="c/:col" element={<CollectionView />} />
            </Route>
            <Route path="workflow" element={<PullsView />} />
            <Route path="media" element={<MediaView />} />
            <Route path="setup" element={<SetupView />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<SiteForm />} />
              <Route path="domains" element={<SiteDomains />} />
              <Route path="members" element={<SiteMembers />} />
              <Route
                path="config"
                element={
                  <Suspense fallback={null}>
                    <ConfigEditor />
                  </Suspense>
                }
              />
            </Route>
            <Route path="c/:col/new" element={<Editor />} />
            <Route path="c/:col/e/:slug" element={<Editor />} />
          </Route>
          {me.is_admin && (
            <>
              <Route path="admin" element={<AdminLayout />}>
                <Route index element={<Navigate to="users" replace />} />
                <Route path="users" element={<Users />} />
                <Route path="sites" element={<AdminSites />} />
                <Route path="ai" element={<AISettingsPage />} />
                <Route path="sso" element={<SSOSettingsPage />} />
              </Route>
              <Route path="admin/sites/new" element={<SiteForm />} />
            </>
          )}
          <Route path="*" element={<p className="text-muted">{t('Page not found.')}</p>} />
        </Route>
      </Routes>
    </>
  );
}

// Monogram gives each site a stable, recognizable mark.
export function Monogram({ name }: { name: string }) {
  const hue = [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-md text-[11px] leading-none font-semibold text-white [text-box:trim-both_cap_alphabetic]" style={{ background: `oklch(0.55 0.15 ${hue})` }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// useFocusMode is true on the editor, which takes the whole screen like a writing app.
export const useFocusMode = () => {
  const edit = useMatch('/sites/:siteId/c/:col/e/:slug');
  const create = useMatch('/sites/:siteId/c/:col/new');
  return !!(edit || create);
};

export const Chevron = ({ dir = 'down' }: { dir?: 'down' | 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={{ down: 'm6 9 6 6 6-6', left: 'm15 18-6-6 6-6', right: 'm9 18 6-6-6-6' }[dir]} />
  </svg>
);

const menuItem = ({ isActive }: { isActive: boolean }) => `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] hover:bg-canvas ${isActive ? 'font-medium text-accent' : ''}`;
const topLink = (active: boolean) => `rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${active ? 'bg-canvas text-ink' : 'text-muted hover:text-ink'}`;

function Layout({ me, sites, reloadSites, setMe, onLogout }: Ctx & { onLogout: () => void }) {
  const focus = useFocusMode();
  const { pathname } = useLocation();
  const current = sites.find((s) => pathname.startsWith(`/sites/${s.id}/`) || pathname === `/sites/${s.id}`);
  const ctx = { me, sites, reloadSites, setMe } satisfies Ctx;
  const logout = async () => {
    await api('POST', '/logout');
    clearCache();
    onLogout();
  };
  // Native <details> menus only toggle from their summary: close them on a click elsewhere or on Escape.
  useEffect(() => {
    const close = (e: PointerEvent | KeyboardEvent) =>
      document.querySelectorAll('header details[open]').forEach((d) => {
        if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.removeAttribute('open');
      });
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  if (focus) return <Outlet context={ctx} />;
  const base = current && `/sites/${current.id}`;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4 md:px-6">
          {base && (
            <nav className="flex items-center gap-1">
              <Link to={base} className={topLink(pathname === base || pathname.startsWith(`${base}/c/`))}>
                {t('Content')}
              </Link>
              <Link to={`${base}/workflow`} className={topLink(pathname === `${base}/workflow`)}>
                {t('Workflow')}
              </Link>
              <Link to={`${base}/media`} className={topLink(pathname === `${base}/media`)}>
                {t('Media')}
              </Link>
            </nav>
          )}
          {/* Menus are keyed by path so they close once a link is followed. */}
          <details key={`sites-${pathname}`} className="relative ml-auto">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-canvas">
              {current ? (
                <>
                  <Monogram name={current.name} />
                  <span className="hidden max-w-48 truncate sm:inline">{current.name}</span>
                </>
              ) : (
                <span className="text-muted">{t('Choose a site')}</span>
              )}
              <Chevron />
            </summary>
            <div className="panel absolute top-full right-0 mt-2 w-72 p-1 shadow-lg">
              {sites.map((s) => (
                <NavLink key={s.id} to={`/sites/${s.id}`} className={menuItem}>
                  <Monogram name={s.name} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{s.repo}</span>
                </NavLink>
              ))}
              {sites.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">{t('No site yet.')}</p>}
              {me.is_admin && (
                <div className="mt-1 border-t border-line pt-1">
                  <NavLink to="/admin/sites/new" className={menuItem}>
                    <span className="grid size-5 place-items-center rounded-md border border-dashed border-muted/50 text-muted">
                      <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                    {t('Add a site')}
                  </NavLink>
                </div>
              )}
            </div>
          </details>
          <details key={`me-${pathname}`} className="relative ml-1">
            <summary
              className="grid size-8 cursor-pointer list-none place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent ring-accent/30 hover:ring-2"
              aria-label={t('Account menu')}
            >
              {me.name.charAt(0).toUpperCase()}
            </summary>
            <div className="panel absolute top-full right-0 mt-2 w-60 p-1 shadow-lg">
              <div className="px-2.5 py-2">
                <div className="truncate text-[13px] font-medium">{me.name}</div>
                <div className="truncate text-xs text-muted">{me.email}</div>
              </div>
              <div className="border-t border-line pt-1">
                <NavLink to="/account" className={menuItem}>
                  {t('My account')}
                </NavLink>
              </div>
              {me.is_admin && (
                <div className="border-t border-line pt-1">
                  <NavLink to="/admin" className={menuItem}>
                    {t('Administration')}
                  </NavLink>
                </div>
              )}
              <label className="mt-1 flex items-center gap-2 border-t border-line px-2.5 pt-2 pb-1 text-[13px] text-muted">
                {t('Language')}
                <select className="field ml-auto w-auto py-1" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                  {Object.entries(languages).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-1 border-t border-line pt-1">
                <button className="flex w-full rounded-md px-2.5 py-2 text-[13px] text-danger hover:bg-canvas" onClick={logout}>
                  {t('Log out')}
                </button>
              </div>
            </div>
          </details>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 md:px-6">
        <Outlet context={ctx} />
      </main>
    </div>
  );
}

// domainSite is the site a custom domain opens, fetched once: null on the instance domain.
const domainSite = api<{ site_id: number | null }>('GET', '/domain').then(
  (d) => d.site_id,
  () => null,
);

function Home() {
  const { me, sites } = useCtx();
  const [siteId, setSiteId] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    domainSite.then(setSiteId);
  }, []);
  if (siteId === undefined) return null;
  if (sites.some((s) => s.id === siteId)) return <Navigate to={`/sites/${siteId}`} replace />;
  return (
    <div className="mx-auto max-w-2xl">
      <h1>{t('Hello {name}', { name: me.name })}</h1>
      <p className="mt-1 text-muted">
        {t(sites.length ? 'Choose a site to manage its articles.' : me.is_admin ? 'Connect a Git repository to start editing its content.' : 'Ask an admin to give you access to a site.')}
      </p>
      {sites.length > 0 ? (
        <ul className="panel mt-6 divide-y divide-line">
          {sites.map((s) => (
            <li key={s.id}>
              <Link to={`/sites/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
                <Monogram name={s.name} />
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-xs text-muted">{s.repo}</span>
                <span className="ml-auto text-xs text-muted">{t(roleNames[s.role ?? 'admin'])}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        me.is_admin && (
          <Link to="/admin/sites/new" className="btn btn-primary mt-6">
            {t('Add a site')}
          </Link>
        )
      )}
    </div>
  );
}

// Account lets users rename themselves (the name signs their commits) and change their password.
function Account() {
  const { me, setMe } = useCtx();
  const [run, pending] = useAction();
  const [names, setNames] = useState({ first_name: me.first_name, last_name: me.last_name });
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const [msg, setMsg] = useState<{ form: 'name' | 'password'; ok: boolean; text: string } | null>(null);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setMe(await api<User>('PUT', '/me', names));
      setMsg({ form: 'name', ok: true, text: t('Saved') });
    } catch (err) {
      setMsg({ form: 'name', ok: false, text: (err as Error).message });
    }
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.password !== pw.confirm) return setMsg({ form: 'password', ok: false, text: t('The two passwords differ.') });
    try {
      await api('POST', '/me/password', { current: pw.current, password: pw.password });
      setPw({ current: '', password: '', confirm: '' });
      setMsg({ form: 'password', ok: true, text: t('Password changed') });
    } catch (err) {
      setMsg({ form: 'password', ok: false, text: (err as Error).message });
    }
  };
  const notice = (form: 'name' | 'password') => msg?.form === form && <p className={`text-[13px] ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1>{t('My account')}</h1>
      <form className="panel flex flex-col gap-4 p-6" onSubmit={(e) => run('name', () => saveName(e))}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="label">
            {t('First name')}
            <input className="field" value={names.first_name} onChange={(e) => setNames({ ...names, first_name: e.target.value })} required autoComplete="given-name" />
          </label>
          <label className="label">
            {t('Last name')}
            <input className="field" value={names.last_name} onChange={(e) => setNames({ ...names, last_name: e.target.value })} autoComplete="family-name" />
          </label>
        </div>
        <label className="label">
          {t('Email')}
          <input className="field" value={me.email} disabled />
        </label>
        {notice('name')}
        <button className="btn btn-primary self-end" disabled={!!pending || (names.first_name.trim() === me.first_name && names.last_name.trim() === me.last_name)}>
          <Pending on={pending === 'name'}>{t('Save changes')}</Pending>
        </button>
      </form>
      <form className="panel flex flex-col gap-4 p-6" onSubmit={(e) => run('password', () => savePassword(e))}>
        <h2>{t('Password')}</h2>
        <label className="label">
          {t('Current password')}
          <input className="field" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required autoComplete="current-password" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="label">
            {t('New password')}
            <input className="field" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} minLength={8} required autoComplete="new-password" />
          </label>
          <label className="label">
            {t('Confirm the password')}
            <input className="field" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} minLength={8} required autoComplete="new-password" />
          </label>
        </div>
        {notice('password')}
        <button className="btn btn-primary self-end" disabled={!!pending}>
          <Pending on={pending === 'password'}>{t('Change the password')}</Pending>
        </button>
      </form>
    </div>
  );
}

// Setup creates the first account of the instance, an admin, with the setup code printed in the server logs.
function Setup({ onDone }: { onDone: (u: User) => void }) {
  const [form, setForm] = useState({ code: '', first_name: '', last_name: '', email: '', password: '' });
  const [run, pending] = useAction();
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<User>('POST', '/setup', form));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form className="w-full max-w-md" onSubmit={(e) => run('setup', () => submit(e))}>
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="size-3 rounded-full bg-accent" />
          Sumigo
        </div>
        <div className="panel flex flex-col gap-4 p-6 shadow-sm">
          <h1 className="text-xl">{t('Set up Sumigo')}</h1>
          <label className="label">
            {t('Setup code')}
            <input className="field font-mono" value={form.code} onChange={set('code')} placeholder={t('Printed in the server logs')} required autoFocus autoComplete="off" spellCheck={false} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="label">
              {t('First name')}
              <input className="field" value={form.first_name} onChange={set('first_name')} required autoComplete="given-name" />
            </label>
            <label className="label">
              {t('Last name')}
              <input className="field" value={form.last_name} onChange={set('last_name')} autoComplete="family-name" />
            </label>
          </div>
          <label className="label">
            {t('Email')}
            <input className="field" type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
          </label>
          <label className="label">
            {t('Password')}
            <input className="field" type="password" value={form.password} onChange={set('password')} minLength={8} required autoComplete="new-password" />
          </label>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <button className="btn btn-primary py-2" disabled={!!pending}>
            <Pending on={!!pending}>{t('Create the admin account')}</Pending>
          </button>
        </div>
      </form>
    </div>
  );
}

// ChoosePassword replaces the temporary password an admin gave, before anything else.
function ChoosePassword({ me, onDone, onLogout }: { me: User; onDone: (u: User) => void; onLogout: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [run, pending] = useAction();
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t('The two passwords differ.'));
    try {
      onDone(await api<User>('POST', '/me/password', { password }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const logout = async () => {
    await api('POST', '/logout');
    onLogout();
  };
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form className="w-full max-w-sm" onSubmit={(e) => run('save', () => submit(e))}>
        <div className="panel flex flex-col gap-4 p-6 shadow-sm">
          <div>
            <h1 className="text-xl">{t('Choose your password')}</h1>
            <p className="text-[13px] text-muted">{me.email}</p>
          </div>
          <label className="label">
            {t('New password')}
            <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus autoComplete="new-password" />
          </label>
          <label className="label">
            {t('Confirm the password')}
            <input className="field" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required autoComplete="new-password" />
          </label>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <button className="btn btn-primary py-2" disabled={!!pending}>
            <Pending on={!!pending}>{t('Save the password')}</Pending>
          </button>
          <button type="button" className="text-[13px] text-muted hover:text-ink" onClick={logout}>
            {t('Log out')}
          </button>
        </div>
      </form>
    </div>
  );
}

// Errors of the single sign-on callback, which redirects to /?login_error=<code>. English text when untranslated.
const ssoErrors: Record<string, string> = {
  oidc_failed: 'Single sign-on failed, try again.',
  oidc_unavailable: 'Single sign-on is unavailable.',
  oidc_email: 'The provider did not share a verified email.',
  oidc_unknown_user: 'No Sumigo account for this email. Ask an admin to add you.',
};

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [run, pending] = useAction();
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(location.search).get('login_error');
    return code ? tError(code, undefined, ssoErrors[code] ?? ssoErrors.oidc_failed) : '';
  });
  const [sso, setSSO] = useState<{ oidc: boolean; label: string } | null>(null);
  useEffect(() => {
    if (location.search.includes('login_error')) history.replaceState(null, '', '/');
    api<{ oidc: boolean; label: string }>('GET', '/auth/config')
      .then(setSSO)
      .catch(() => {});
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onLogin(await api<User>('POST', '/login', { email, password }));
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('Login failed'));
    }
  };
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form className="w-full max-w-sm" onSubmit={(e) => run('login', () => submit(e))}>
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="size-3 rounded-full bg-accent" />
          Sumigo
        </div>
        <div className="panel flex flex-col gap-4 p-6 shadow-sm">
          <div>
            <h1 className="text-xl">{t('Log in')}</h1>
            <p className="text-[13px] text-muted">{t('Use the account an admin created for you.')}</p>
          </div>
          <label className="label">
            {t('Email')}
            <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="label">
            {t('Password')}
            <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <button className="btn btn-primary py-2" disabled={!!pending}>
            <Pending on={!!pending}>{t(pending ? 'Logging in…' : 'Log in')}</Pending>
          </button>
          {sso?.oidc && (
            <a href="/api/auth/oidc" className="btn justify-center py-2">
              {t('Continue with {provider}', { provider: sso.label || 'SSO' })}
            </a>
          )}
        </div>
      </form>
    </div>
  );
}
