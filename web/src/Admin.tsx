import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { Access, AISettings, api, OIDCSettings, Forge, forgeNames, forgeURL, Role, Site, User } from './api';
import { Monogram, roleNames, useCtx } from './App';
import { t } from './i18n';
import { Pending, useAction, useConfirm } from './ui';
import { Empty, Notice, PageHeader } from './Site';

const emptySite: Site = {
  id: 0,
  name: '',
  repo: '',
  forge: 'github',
  forge_url: 'https://github.com',
  branch: 'main',
  workflow: 'direct',
  has_token: false,
  ai_enabled: false,
};

// Public instances, prefilled and replaced by self-hosted users. Forgejo / Gitea has none, Codeberg is one among many.
const defaultURLs: Record<Forge, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: '' };

// tokenURL opens the token form of the forge, prefilled where the forge allows it.
// GitHub prefills owner and permissions but not the repository, the user picks it in the form.
function tokenURL(site: Site) {
  const base = forgeURL(site);
  if (site.forge === 'gitlab') return `${base}/-/user_settings/personal_access_tokens?name=Sumigo&scopes=api`;
  if (site.forge === 'gitea') return site.forge_url && `${base}/user/settings/applications`;
  const repo = site.repo;
  const [owner, name] = repo.trim().split('/');
  if (!owner || !name) return '';
  const params = new URLSearchParams({
    name: `Sumigo ${repo.trim()}`.slice(0, 40),
    description: `Sumigo CMS access to ${repo.trim()}`,
    target_name: owner,
    expires_in: '366',
    contents: 'write',
    pull_requests: 'write',
  });
  return `${base}/settings/personal-access-tokens/new?${params}`;
}

export function SiteForm() {
  const { siteId } = useParams();
  const { sites, reloadSites } = useCtx();
  const [run, pending] = useAction();
  const navigate = useNavigate();
  const [site, setSite] = useState<Site>(emptySite);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    const s = sites.find((s) => String(s.id) === siteId);
    setSite(s ? { ...s, forge_url: s.forge_url || defaultURLs[s.forge], token: '' } : emptySite);
  }, [siteId, sites]);

  const set = (k: keyof Site) => (e: { target: { value: string } }) => setSite({ ...site, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const saved = await api<Site>(site.id ? 'PUT' : 'POST', site.id ? `/sites/${site.id}` : '/sites', site);
      reloadSites();
      setStatus(t('Saved'));
      // A new site opens on its own page, which offers the setup when the repository has no sumigo.yml.
      if (!site.id) navigate(`/sites/${saved.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const check = async () => {
    setStatus('');
    setError('');
    try {
      const res = await api<{ collections: number }>('POST', `/sites/${site.id}/check`);
      setStatus(
        t('{forge} access OK, sumigo.yml loaded with {n} collection(s)', {
          forge: forgeNames[site.forge],
          n: res.collections,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const [ask, confirmDialog] = useConfirm();
  const remove = async () => {
    if (!(await ask({ title: t('Delete site {name}? The repository is not touched.', { name: site.name }), action: t('Delete site'), danger: true }))) return;
    await api('DELETE', `/sites/${site.id}`);
    reloadSites();
    navigate('/');
  };

  const aiHint = t('Suggests field values and proofreads articles. It must also be turned on in {link}.').split('{link}');
  const repoHint = t('(permissions are prefilled, select only {repo} under "Repository access").').split('{repo}');

  return (
    <div className={site.id ? 'max-w-3xl' : 'mx-auto max-w-3xl'}>
      {confirmDialog}
      {site.id ? (
        <PageHeader title={t('General')} />
      ) : (
        <div className="mb-6">
          <h1>{t('Add a site')}</h1>
          <p className="text-muted">{t('Connect a Git repository that contains a sumigo.yml.')}</p>
        </div>
      )}
      <form className="panel" onSubmit={(e) => run('save', () => save(e))}>
        <div className="border-b border-line px-6 py-4">
          <h2>{t('Repository')}</h2>
          <p className="text-[13px] text-muted">{t('Where the content lives and how changes reach it.')}</p>
        </div>
        <div className="flex flex-col gap-5 p-6">
          <label className="label">
            {t('Name')}
            <input className="field" value={site.name} onChange={set('name')} required />
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('Forge')}
              <select className="field" value={site.forge} onChange={(e) => {
                  const forge = e.target.value as Forge;
                  // Swap the public instance with the forge, keep a self-hosted URL the user typed.
                  setSite({ ...site, forge, forge_url: Object.values(defaultURLs).includes(site.forge_url) ? defaultURLs[forge] : site.forge_url });
                }}>
                {Object.entries(forgeNames).map(([k, name]) => (
                  <option key={k} value={k}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              {t('Instance URL')}
              <input
                className="field font-mono"
                type="url"
                value={site.forge_url}
                onChange={set('forge_url')}
                placeholder="https://codeberg.org"
                required
              />
            </label>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('Repository')}
              <input className="field font-mono" value={site.repo} onChange={set('repo')} placeholder="acme/blog" required />
            </label>
            <label className="label">
              {t('Branch')}
              <input className="field font-mono" value={site.branch} onChange={set('branch')} required />
            </label>
          </div>
          <label className="label">
            <span>
              {t('Access token')} {site.has_token && <span className="font-normal text-muted">{t('(already set, leave empty to keep it)')}</span>}
            </span>
            <input className="field font-mono" type="password" value={site.token ?? ''} onChange={set('token')} placeholder={{ github: 'github_pat_…', gitlab: 'glpat-…', gitea: '' }[site.forge]} autoComplete="off" />
            <span className="text-xs font-normal text-muted">
              {t(
                site.forge === 'github'
                  ? 'Fine-grained token with Contents and Pull requests read/write on this repository.'
                  : site.forge === 'gitlab'
                    ? 'Project or personal access token with the api scope.'
                    : 'Access token with read and write on repository.',
              )}{' '}
              {tokenURL(site) ? (
                <>
                  <a href={tokenURL(site)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {t('Create it on {forge}', { forge: forgeNames[site.forge] })}
                  </a>
                  {site.forge === 'github' && (
                    <>
                      {' '}
                      {repoHint[0]}
                      <strong className="font-medium text-ink">{site.repo}</strong>
                      {repoHint[1]}
                    </>
                  )}
                </>
              ) : (
                t('Fill the repository to get a prefilled link.')
              )}
            </span>
          </label>
          <label className="label">
            {t('Publishing')}
            <select className="field" value={site.workflow} onChange={set('workflow')}>
              <option value="direct">{t('Open: editors can publish, or save drafts')}</option>
              <option value="pr">{t('Review: editors save drafts, only publishers publish them')}</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-[13px] font-medium">
            <input className="mt-0.5 size-4 accent-accent" type="checkbox" checked={site.ai_enabled} onChange={(e) => setSite({ ...site, ai_enabled: e.target.checked })} />
            <span>
              {t('AI assistant')}
              <span className="block font-normal text-muted">
                {aiHint[0]}
                <Link to="/admin/ai" className="text-accent hover:underline">
                  {t('AI assistant settings')}
                </Link>
                {aiHint[1]}
              </span>
            </span>
          </label>
          {error && <Notice>{error}</Notice>}
          {status && <Notice tone="ok">{status}</Notice>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-canvas/60 px-6 py-3">
          {site.id > 0 && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => run('delete', remove)} disabled={!!pending}>
                <Pending on={pending === 'delete'}>{t(pending === 'delete' ? 'Deleting…' : 'Delete site')}</Pending>
              </button>
              <span className="flex-1" />
              <button type="button" className="btn" onClick={() => run('check', check)} disabled={!!pending}>
                <Pending on={pending === 'check'}>{t(pending === 'check' ? 'Testing…' : 'Test access')}</Pending>
              </button>
            </>
          )}
          <button className="btn btn-primary ml-auto" disabled={!!pending}>
            <Pending on={pending === 'save'}>{t(pending === 'save' ? 'Saving…' : site.id ? 'Save changes' : 'Add site')}</Pending>
          </button>
        </div>
      </form>
    </div>
  );
}

// UserRow is a user of the admin list, with the sites they were given a role on (none for admins: all sites).
type UserRow = User & { sites: { site_id: number; name: string; role: Role }[] };

export function Users() {
  const { me } = useCtx();
  const [run, pending] = useAction();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [editing, setEditing] = useState<(User & { password: string; temporary: boolean }) | null>(null);
  const [error, setError] = useState('');
  // The generated temporary password, shown once after saving.
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);

  const load = () => api<UserRow[]>('GET', '/users').then(setUsers);
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError('');
    try {
      const saved = await api<User & { temporary_password?: string }>(editing.id ? 'PUT' : 'POST', editing.id ? `/users/${editing.id}` : '/users', editing);
      setCreated(saved.temporary_password ? { name: saved.name, password: saved.temporary_password } : null);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const edit = (u: User | null) => {
    setError('');
    setCreated(null);
    setEditing(u ? { ...u, password: '', temporary: false } : { id: 0, email: '', name: '', first_name: '', last_name: '', is_admin: false, password: '', temporary: true });
  };

  const [ask, confirmDialog] = useConfirm();
  const remove = async (u: User) => {
    if (!(await ask({ title: t('Delete {name}?', { name: u.name }), action: t('Delete'), danger: true }))) return;
    await api('DELETE', `/users/${u.id}`);
    load();
  };

  return (
    <div className="max-w-3xl">
      {confirmDialog}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1>{t('Users')}</h1>
          <p className="text-muted">{t('Their name and email sign the commits they make.')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => edit(null)}>
          {t('New user')}
        </button>
      </div>
      {created && (
        <div className="panel mb-6 flex flex-wrap items-center gap-3 p-4 text-[13px]">
          <span className="flex-1">{t('Temporary password of {name}, shown once:', { name: created.name })}</span>
          <code className="rounded bg-canvas px-2 py-1 font-mono text-sm select-all">{created.password}</code>
          <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(created.password)}>
            {t('Copy')}
          </button>
        </div>
      )}
      {editing && (
        <form className="panel mb-6 flex flex-col gap-5 p-6" onSubmit={(e) => run('save', () => save(e))}>
          <h2>{editing.id ? t('Edit {name}', { name: `${editing.first_name} ${editing.last_name}`.trim() }) : t('New user')}</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('First name')}
              <input className="field" value={editing.first_name} onChange={(e) => setEditing({ ...editing, first_name: e.target.value })} required autoComplete="off" />
            </label>
            <label className="label">
              {t('Last name')}
              <input className="field" value={editing.last_name} onChange={(e) => setEditing({ ...editing, last_name: e.target.value })} autoComplete="off" />
            </label>
          </div>
          <label className="label">
            {t('Email')}
            <input className="field" type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
          </label>
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input className="size-4 accent-accent" type="checkbox" checked={editing.temporary} onChange={(e) => setEditing({ ...editing, temporary: e.target.checked, password: '' })} />
            {t(editing.id ? 'Reset with a temporary password' : 'Temporary password')}
            <span className="font-normal text-muted">{t('(changed at the first login)')}</span>
          </label>
          {!editing.temporary && (
            <label className="label">
              <span>
                {t('Password')} {editing.id > 0 && <span className="font-normal text-muted">{t('(leave empty to keep it)')}</span>}
              </span>
              <input
                className="field"
                type="password"
                value={editing.password}
                minLength={8}
                required={!editing.id}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                autoComplete="new-password"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input className="size-4 accent-accent" type="checkbox" checked={editing.is_admin} onChange={(e) => setEditing({ ...editing, is_admin: e.target.checked })} /> {t('Administrator')}{' '}
            <span className="font-normal text-muted">{t('(manages users and sites, sees every site)')}</span>
          </label>
          {error && <Notice>{error}</Notice>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t('Cancel')}
            </button>
            <button className="btn btn-primary" disabled={!!pending}>
              <Pending on={pending === 'save'}>{t(pending === 'save' ? 'Saving…' : 'Save user')}</Pending>
            </button>
          </div>
        </form>
      )}
      <div className="panel overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-line bg-canvas/60 text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">{t('Name')}</th>
              <th className="hidden px-4 py-2 font-medium sm:table-cell">{t('Email')}</th>
              <th className="px-4 py-2 font-medium">{t('Role')}</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {u.name} {u.must_change_password && <span className="pill ml-1 bg-canvas text-muted ring-1 ring-line">{t('Temporary password')}</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {t('Access:')}{' '}
                    {u.is_admin
                      ? t('every site')
                      : u.sites.length
                        ? u.sites.map((s, i) => (
                            <span key={s.site_id}>
                              {i > 0 && ', '}
                              <Link to={`/sites/${s.site_id}/settings/members`} className="hover:text-accent">
                                {s.name}
                              </Link>{' '}
                              ({t(roleNames[s.role])})
                            </span>
                          ))
                        : t('no site')}
                  </div>
                </td>
                <td className="hidden px-4 py-3 text-muted sm:table-cell">{u.email}</td>
                <td className="px-4 py-3">{u.is_admin ? <span className="pill bg-accent-soft text-accent">{t('Admin')}</span> : <span className="text-muted">{t('Member')}</span>}</td>
                <td className="space-x-4 px-4 py-3 text-right text-[13px] font-medium">
                  <button className="text-accent hover:underline" onClick={() => edit(u)}>
                    {t('Edit')}
                  </button>
                  {u.id !== me.id && (
                    <button className="inline-flex items-center gap-1 text-danger hover:underline" onClick={() => run(`del${u.id}`, () => remove(u))} disabled={!!pending}>
                      <Pending on={pending === `del${u.id}`}>{t(pending === `del${u.id}` ? 'Deleting…' : 'Delete')}</Pending>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// SiteMembers sets who can open a site and with which role. Admins are left out: they see every site.
// SiteDomains lists the custom domains (CNAME to the instance) that open the site.
export function SiteDomains() {
  const { siteId } = useParams();
  const { sites } = useCtx();
  const [run, pending] = useAction();
  const site = sites.find((s) => String(s.id) === siteId);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = () =>
    api<string[]>('GET', `/sites/${siteId}/domains`)
      .then((d) => setDomains(d.join('\n')))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!site) return;
    setError('');
    setStatus('');
    try {
      // Domains are saved with the site: the token is left empty, so it is kept.
      await api('PUT', `/sites/${site.id}`, { ...site, token: '', domains: domains.split('\n') });
      await load();
      setStatus(t('Saved'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title={t('Domains')} />
      <form className="panel" onSubmit={(e) => run('save', () => save(e))}>
        <div className="flex flex-col gap-4 p-6">
          <textarea className="field min-h-32 font-mono" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="cms.client.com" spellCheck={false} aria-label={t('Domains')} />
          <span className="text-xs text-muted">{t('CNAME to {host}, one domain per line.', { host: location.hostname })}</span>
          {error && <Notice>{error}</Notice>}
          {status && <Notice tone="ok">{status}</Notice>}
        </div>
        <div className="flex justify-end border-t border-line bg-canvas/60 px-6 py-3">
          <button className="btn btn-primary" disabled={!!pending}>
            <Pending on={!!pending}>{t(pending ? 'Saving…' : 'Save changes')}</Pending>
          </button>
        </div>
      </form>
    </div>
  );
}

// SiteMembers lists who opens the site: admins (all sites), then the users given a role here.
// Every change is saved right away.
export function SiteMembers() {
  const { siteId } = useParams();
  const [users, setUsers] = useState<User[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // Adding a member: an email first; an unknown email then gets a name and a temporary password.
  const emptyForm = { step: 'email' as 'email' | 'create' | 'done', email: '', first_name: '', last_name: '', role: 'editor' as Role, password: '', note: '' };
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    api<User[]>('GET', '/users').then(setUsers);
    api<Access[]>('GET', `/sites/${siteId}/access`).then(setAccess);
  }, [siteId]);

  const save = async (next: Access[]) => {
    setError('');
    setBusy(true);
    try {
      await api('PUT', `/sites/${siteId}/access`, next);
      setAccess(next);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setRole = (id: number, role: Role | null) => save([...access.filter((a) => a.user_id !== id), ...(role ? [{ user_id: id, role }] : [])]);

  const admins = users.filter((u) => u.is_admin);
  const members = access.map((a) => ({ user: users.find((u) => u.id === a.user_id), role: a.role })).filter((m) => m.user && !m.user.is_admin);
  const openAdd = () => {
    setError('');
    setForm(emptyForm);
    dialog.current?.showModal();
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.step === 'email') {
      const known = users.find((u) => u.email.toLowerCase() === form.email.trim().toLowerCase());
      if (!known) return setForm({ ...form, step: 'create' });
      if (known.is_admin) return setForm({ ...form, note: t('{name} is an admin and already opens every site.', { name: known.name }) });
      if (await setRole(known.id, form.role)) dialog.current?.close();
      return;
    }
    // Unknown email: create the user with a temporary password, then give them the role.
    setBusy(true);
    try {
      const created = await api<User & { temporary_password: string }>('POST', '/users', { email: form.email.trim(), first_name: form.first_name, last_name: form.last_name, temporary: true });
      setUsers((list) => [...list, created]);
      if (await setRole(created.id, form.role)) setForm({ ...form, step: 'done', password: created.temporary_password });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (u: User, right: ReactNode) => (
    <li key={u.id} className="flex items-center gap-3 px-5 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-canvas text-xs font-semibold text-muted">{u.name.charAt(0).toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{u.name}</div>
        <div className="truncate text-xs text-muted">{u.email}</div>
      </div>
      {right}
    </li>
  );
  const roleSelect = (value: Role, onChange: (r: Role) => void, label: string, width = 'w-40 py-1') => (
    <select className={`field ${width}`} value={value} onChange={(e) => onChange(e.target.value as Role)} aria-label={label} disabled={busy}>
      {(['viewer', 'editor', 'publisher'] as const).map((r) => (
        <option key={r} value={r}>
          {t(roleNames[r])}
        </option>
      ))}
    </select>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title={t('Members')}>
        <button type="button" className="btn btn-primary" onClick={openAdd}>
          {t('Add a member')}
        </button>
      </PageHeader>
      {error && (
        <div className="mb-4">
          <Notice>{error}</Notice>
        </div>
      )}
      <ul className="panel divide-y divide-line">
        {admins.map((u) =>
          row(
            u,
            <span className="pill w-40 justify-center bg-accent-soft text-accent" title={t('Admins open every site')}>
              {t('Admin')}
            </span>,
          ),
        )}
        {members.map(({ user, role }) =>
          row(
            user!,
            <>
              {roleSelect(role, (r) => setRole(user!.id, r), t('Role of {name}', { name: user!.name }))}
              <button type="button" className="btn btn-danger py-1" onClick={() => setRole(user!.id, null)} disabled={busy} aria-label={t('Remove {name}', { name: user!.name })}>
                {t('Remove')}
              </button>
            </>,
          ),
        )}
      </ul>

      <dialog ref={dialog} className="panel m-auto w-[calc(100%-2rem)] max-w-sm p-0 text-ink shadow-xl backdrop:bg-ink/30">
        <form className="flex flex-col gap-4 p-6" onSubmit={add}>
          <h2>{t('Add a member')}</h2>
          {form.step === 'done' ? (
            <>
              <p className="text-[13px]">{t('Temporary password of {name}, shown once:', { name: `${form.first_name} ${form.last_name}`.trim() })}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-canvas px-2 py-1.5 font-mono text-sm select-all">{form.password}</code>
                <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(form.password)}>
                  {t('Copy')}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="label">
                {t('Email')}
                <input
                  className="field"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value, step: 'email', note: '' })}
                  required
                  autoFocus
                  autoComplete="off"
                />
              </label>
              <label className="label">
                {t('Role')}
                {roleSelect(form.role, (role) => setForm({ ...form, role }), t('Role'), 'h-[38px] w-full')}
              </label>
              {form.note && <p className="text-[13px] text-muted">{form.note}</p>}
              {form.step === 'create' && (
                <>
                  <p className="text-[13px] text-muted">{t('No account with this email: it is created with a temporary password.')}</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="label">
                      {t('First name')}
                      <input className="field" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required autoFocus autoComplete="off" />
                    </label>
                    <label className="label">
                      {t('Last name')}
                      <input className="field" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} autoComplete="off" />
                    </label>
                  </div>
                </>
              )}
              {error && <Notice>{error}</Notice>}
            </>
          )}
          <div className="flex justify-end gap-2">
            {form.step === 'done' ? (
              <button type="button" className="btn btn-primary" onClick={() => dialog.current?.close()}>
                {t('Done')}
              </button>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => dialog.current?.close()}>
                  {t('Cancel')}
                </button>
                <button className="btn btn-primary" disabled={busy}>
                  <Pending on={busy}>{t(form.step === 'create' ? 'Create and add' : 'Continue')}</Pending>
                </button>
              </>
            )}
          </div>
        </form>
      </dialog>
    </div>
  );
}

// Each provider: its key and model pages, and the models offered in a list (others take a typed model id).
const providers: Record<string, { name: string; keys?: string; models?: string; choices?: string[] }> = {
  anthropic: { name: 'Anthropic (Claude)', keys: 'https://console.anthropic.com/settings/keys', choices: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  openai: { name: 'OpenAI', keys: 'https://platform.openai.com/api-keys', models: 'https://platform.openai.com/docs/models' },
  mistral: { name: 'Mistral AI', keys: 'https://console.mistral.ai/api-keys', models: 'https://docs.mistral.ai/getting-started/models/' },
  gemini: { name: 'Google Gemini', keys: 'https://aistudio.google.com/apikey', models: 'https://ai.google.dev/gemini-api/docs/models' },
  openrouter: { name: 'OpenRouter', keys: 'https://openrouter.ai/keys', models: 'https://openrouter.ai/models' },
  custom: { name: '' },
};

// AISettingsPage sets the assistant up for the whole instance. Each site then opts in from its settings.
export function AISettingsPage() {
  const { sites } = useCtx();
  const [run, pending] = useAction();
  const [ai, setAI] = useState<AISettings | null>(null);
  const [saved, setSaved] = useState<AISettings | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = (s: AISettings) => {
    setSaved(s);
    setAI({ ...s, model: s.model || (providers[s.provider]?.choices?.[0] ?? ''), api_key: '' });
  };
  useEffect(() => {
    api<AISettings>('GET', '/settings/ai')
      .then(load)
      .catch((e) => setError(e.message));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setStatus('');
    try {
      load(await api<AISettings>('PUT', '/settings/ai', ai));
      setStatus(t('Saved'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!ai) return error ? <Notice>{error}</Notice> : null;
  const p = providers[ai.provider] ?? providers.custom;
  // The saved key belongs to the saved provider: switching provider asks for a new one.
  const keyKept = saved?.has_key && saved.provider === ai.provider;
  const setProvider = (provider: string) => setAI({ ...ai, provider, model: providers[provider]?.choices?.[0] ?? '', base_url: '' });
  const enabledSites = sites.filter((s) => s.ai_enabled);
  return (
    <div className="max-w-3xl">
      <h1 className="mb-6">{t('AI assistant')}</h1>
      <form className="panel" onSubmit={(e) => run('save', () => save(e))}>
        <div className="flex flex-col gap-5 p-6">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input className="size-4 accent-accent" type="checkbox" checked={ai.enabled} onChange={(e) => setAI({ ...ai, enabled: e.target.checked })} />
            {t('Enable the AI assistant')}
          </label>
          <label className="label">
            {t('Provider')}
            <select className="field" value={ai.provider} onChange={(e) => setProvider(e.target.value)}>
              {Object.entries(providers).map(([id, v]) => (
                <option key={id} value={id}>
                  {v.name || t('Other (OpenAI-compatible API, Ollama…)')}
                </option>
              ))}
            </select>
          </label>
          {ai.provider === 'custom' && (
            <label className="label">
              {t('API URL')}
              <input className="field font-mono" value={ai.base_url} onChange={(e) => setAI({ ...ai, base_url: e.target.value })} placeholder="http://localhost:11434/v1" required={ai.enabled} />
              <span className="text-xs font-normal text-muted">{t('The address the /chat/completions route is under.')}</span>
            </label>
          )}
          <label className="label">
            <span>
              {t('API key')} {keyKept && <span className="font-normal text-muted">{t('(already set, leave empty to keep it)')}</span>}
              {ai.provider === 'custom' && <span className="font-normal text-muted"> {t('(optional)')}</span>}
            </span>
            <input className="field font-mono" type="password" value={ai.api_key ?? ''} onChange={(e) => setAI({ ...ai, api_key: e.target.value })} autoComplete="off" />
            {p.keys && (
              <a href={p.keys} target="_blank" rel="noreferrer" className="text-xs font-normal text-accent hover:underline">
                {t('Create a key on {provider}', { provider: p.name })}
              </a>
            )}
          </label>
          <label className="label">
            {t('Model')}
            {p.choices ? (
              <select className="field" value={ai.model} onChange={(e) => setAI({ ...ai, model: e.target.value })}>
                {p.choices.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input className="field font-mono" value={ai.model} onChange={(e) => setAI({ ...ai, model: e.target.value })} required={ai.enabled} />
                {p.models && (
                  <a href={p.models} target="_blank" rel="noreferrer" className="text-xs font-normal text-accent hover:underline">
                    {t('See the model ids of {provider}', { provider: p.name })}
                  </a>
                )}
              </>
            )}
          </label>
          <div className="text-[13px]">
            <h3 className="font-medium">{t('Sites')}</h3>
            <p className="text-muted">{enabledSites.length ? enabledSites.map((s) => s.name).join(', ') : t('No site uses it yet. Turn it on in the settings of each site.')}</p>
          </div>
          {error && <Notice>{error}</Notice>}
          {status && <Notice tone="ok">{status}</Notice>}
        </div>
        <div className="flex justify-end border-t border-line bg-canvas/60 px-6 py-3">
          <button className="btn btn-primary" disabled={!!pending}>
            <Pending on={!!pending}>{t(pending ? 'Saving…' : 'Save changes')}</Pending>
          </button>
        </div>
      </form>
    </div>
  );
}

// SSOSettingsPage connects an OpenID Connect provider for login.
export function SSOSettingsPage() {
  const [run, pending] = useAction();
  const [sso, setSSO] = useState<OIDCSettings | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const { sites } = useCtx();

  useEffect(() => {
    api<OIDCSettings>('GET', '/settings/oidc')
      .then((s) => setSSO({ ...s, client_secret: '' }))
      .catch((e) => setError(e.message));
  }, []);
  // Every custom domain needs its own redirect URI at the provider.
  useEffect(() => {
    Promise.all(sites.map((s) => api<string[]>('GET', `/sites/${s.id}/domains`).catch(() => [])))
      .then((all) => setDomains(all.flat()))
      .catch(() => {});
  }, [sites]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setStatus('');
    try {
      const s = await api<OIDCSettings>('PUT', '/settings/oidc', sso);
      setSSO({ ...s, client_secret: '' });
      setStatus(t('Saved'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!sso) return error ? <Notice>{error}</Notice> : null;
  const set = (k: keyof OIDCSettings) => (e: { target: { value: string } }) => setSSO({ ...sso, [k]: e.target.value });
  const callbacks = [location.host, ...domains].map((h) => `${location.protocol}//${h}/api/auth/oidc/callback`);
  return (
    <div className="max-w-3xl">
      <h1 className="mb-6">{t('Single sign-on')}</h1>
      <form className="panel" onSubmit={(e) => run('save', () => save(e))}>
        <div className="flex flex-col gap-5 p-6">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input className="size-4 accent-accent" type="checkbox" checked={sso.enabled} onChange={(e) => setSSO({ ...sso, enabled: e.target.checked })} />
            {t('Enable login with an OpenID Connect provider')}
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('Issuer URL')}
              <input className="field font-mono" type="url" value={sso.issuer} onChange={set('issuer')} placeholder="https://auth.example.com/realms/acme" required={sso.enabled} />
            </label>
            <label className="label">
              {t('Button label')}
              <input className="field" value={sso.label} onChange={set('label')} placeholder="Keycloak" />
            </label>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('Client ID')}
              <input className="field font-mono" value={sso.client_id} onChange={set('client_id')} required={sso.enabled} />
            </label>
            <label className="label">
              <span>
                {t('Client secret')} {sso.has_secret && <span className="font-normal text-muted">{t('(already set, leave empty to keep it)')}</span>}
              </span>
              <input className="field font-mono" type="password" value={sso.client_secret ?? ''} onChange={set('client_secret')} autoComplete="off" />
            </label>
          </div>
          <div className="label">
            {t('Redirect URIs to register')}
            <pre className="field overflow-x-auto font-mono text-xs leading-5 select-all">{callbacks.join('\n')}</pre>
          </div>
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input className="size-4 accent-accent" type="checkbox" checked={sso.auto_create} onChange={(e) => setSSO({ ...sso, auto_create: e.target.checked })} />
            {t('Create the account on first login')}
          </label>
          <label className="label">
            {t('Admin group')}
            <input className="field font-mono" value={sso.admin_group} onChange={set('admin_group')} placeholder="sumigo-admins" />
            <span className="text-xs font-normal text-muted">{t('Members of this "groups" claim are admins, the others are not. Empty: managed in Sumigo.')}</span>
          </label>
          {error && <Notice>{error}</Notice>}
          {status && <Notice tone="ok">{status}</Notice>}
        </div>
        <div className="flex justify-end border-t border-line bg-canvas/60 px-6 py-3">
          <button className="btn btn-primary" disabled={!!pending}>
            <Pending on={!!pending}>{t(pending ? 'Saving…' : 'Save changes')}</Pending>
          </button>
        </div>
      </form>
    </div>
  );
}

const adminLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${isActive ? 'bg-surface font-medium text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'}`;

// AdminLayout groups the instance-wide settings, next to a sidebar like the content pages.
export function AdminLayout() {
  const ctx = useCtx();
  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <aside className="shrink-0 md:w-52">
        <nav className="flex flex-col gap-0.5">
          <p className="mb-6 px-2.5 text-2xl font-semibold tracking-tight">{t('Administration')}</p>
          <NavLink to="/admin/users" className={adminLink}>
            {t('Users')}
          </NavLink>
          <NavLink to="/admin/sites" end className={adminLink}>
            {t('Sites')}
          </NavLink>
          <NavLink to="/admin/ai" className={adminLink}>
            {t('AI assistant')}
          </NavLink>
          <NavLink to="/admin/sso" className={adminLink}>
            {t('Single sign-on')}
          </NavLink>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}

// AdminSites lists every site with shortcuts to its members and settings.
export function AdminSites() {
  const { sites } = useCtx();
  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1>{t('Sites')}</h1>
          <p className="text-muted">{t('Every site of this instance. Admins see them all.')}</p>
        </div>
        <Link to="/admin/sites/new" className="btn btn-primary">
          {t('Add a site')}
        </Link>
      </div>
      {sites.length === 0 ? (
        <Empty>{t('No site yet.')}</Empty>
      ) : (
        <ul className="panel divide-y divide-line">
          {sites.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Monogram name={s.name} />
              <Link to={`/sites/${s.id}`} className="font-medium hover:text-accent">
                {s.name}
              </Link>
              <span className="font-mono text-xs text-muted">{s.repo}</span>
              {s.ai_enabled && <span className="pill bg-accent-soft text-accent">{t('AI assistant')}</span>}
              <span className="ml-auto space-x-4 text-[13px] font-medium">
                <Link to={`/sites/${s.id}/settings/members`} className="text-accent hover:underline">
                  {t('Members')}
                </Link>
                <Link to={`/sites/${s.id}/settings`} className="text-accent hover:underline">
                  {t('Settings')}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
