import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Access, api, Role, Site, User } from './api';
import { roleNames, useCtx } from './App';
import { t } from './i18n';
import { Pending, useAction } from './ui';
import { Notice } from './Site';

const emptySite: Site = {
  id: 0,
  name: '',
  repo: '',
  branch: 'main',
  workflow: 'direct',
  has_token: false,
};

// tokenURL opens GitHub's fine-grained token form with owner and permissions prefilled.
// GitHub does not allow prefilling the repository, the user picks it in the form.
function tokenURL(repo: string) {
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
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
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
    setSite(s ? { ...s, token: '' } : emptySite);
  }, [siteId, sites]);

  const set = (k: keyof Site) => (e: { target: { value: string } }) => setSite({ ...site, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const saved = await api<Site>(site.id ? 'PUT' : 'POST', site.id ? `/sites/${site.id}` : '/sites', site);
      reloadSites();
      setStatus(t('Saved'));
      if (!site.id) navigate(`/admin/sites/${saved.id}`);
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
        t('GitHub access OK, sumigo.yml loaded with {n} collection(s)', {
          n: res.collections,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        t('Delete site {name}? The repository is not touched.', {
          name: site.name,
        }),
      )
    )
      return;
    await api('DELETE', `/sites/${site.id}`);
    reloadSites();
    navigate('/');
  };

  const repoHint = t('(permissions are prefilled, select only {repo} under "Repository access").').split('{repo}');

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        {site.id > 0 && (
          <Link to={`/sites/${site.id}`} className="text-[13px] text-muted hover:text-accent">
            {t('Back to {name}', { name: site.name })}
          </Link>
        )}
        <h1>{t(site.id ? 'Site settings' : 'Add a site')}</h1>
        {!site.id && <p className="text-muted">{t('Connect a GitHub repository that contains a sumigo.yml.')}</p>}
      </div>
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
              {t('GitHub token')} {site.has_token && <span className="font-normal text-muted">{t('(already set, leave empty to keep it)')}</span>}
            </span>
            <input className="field font-mono" type="password" value={site.token ?? ''} onChange={set('token')} placeholder="github_pat_…" autoComplete="off" />
            <span className="text-xs font-normal text-muted">
              {t('Fine-grained token with Contents and Pull requests read/write on this repository.')}{' '}
              {tokenURL(site.repo) ? (
                <>
                  <a href={tokenURL(site.repo)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {t('Create it on GitHub')}
                  </a>{' '}
                  {repoHint[0]}
                  <strong className="font-medium text-ink">{site.repo}</strong>
                  {repoHint[1]}
                </>
              ) : (
                t('Fill the repository to get a prefilled GitHub link.')
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
                <Pending on={pending === 'check'}>{t(pending === 'check' ? 'Testing…' : 'Test GitHub access')}</Pending>
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

export function Users() {
  const { me } = useCtx();
  const [run, pending] = useAction();
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<(User & { password: string }) | null>(null);
  const [error, setError] = useState('');

  const load = () => api<User[]>('GET', '/users').then(setUsers);
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError('');
    try {
      await api(editing.id ? 'PUT' : 'POST', editing.id ? `/users/${editing.id}` : '/users', editing);
      setEditing(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const edit = (u: User | null) => {
    setError('');
    setEditing(u ? { ...u, password: '' } : { id: 0, email: '', name: '', is_admin: false, password: '' });
  };

  const remove = async (u: User) => {
    if (!confirm(t('Delete {name}?', { name: u.name }))) return;
    await api('DELETE', `/users/${u.id}`);
    load();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1>{t('Users')}</h1>
          <p className="text-muted">{t('Their name and email sign the commits they make.')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => edit(null)}>
          {t('New user')}
        </button>
      </div>
      {editing && (
        <form className="panel mb-6 flex flex-col gap-5 p-6" onSubmit={(e) => run('save', () => save(e))}>
          <h2>{editing.id ? t('Edit {name}', { name: editing.name }) : t('New user')}</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="label">
              {t('Name')}
              <input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            </label>
            <label className="label">
              {t('Email')}
              <input className="field" type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
            </label>
          </div>
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
                <td className="px-4 py-3 font-medium">{u.name}</td>
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
export function SiteMembers() {
  const { siteId } = useParams();
  const { sites } = useCtx();
  const [run, pending] = useAction();
  const site = sites.find((s) => String(s.id) === siteId);
  const [users, setUsers] = useState<User[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<User[]>('GET', '/users').then(setUsers);
    api<Access[]>('GET', `/sites/${siteId}/access`).then(setAccess);
  }, [siteId]);

  const roleOf = (id: number) => access.find((a) => a.user_id === id)?.role ?? '';
  const setRole = (id: number, role: string) => {
    setStatus('');
    setAccess((list) => [...list.filter((a) => a.user_id !== id), ...(role ? [{ user_id: id, role: role as Role }] : [])]);
  };
  const save = async () => {
    setError('');
    try {
      await api('PUT', `/sites/${siteId}/access`, access);
      setStatus(t('Members saved'));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const members = users.filter((u) => !u.is_admin);
  const noUser = t('No user to add yet. {link} first.').split('{link}');

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link to={`/sites/${siteId}`} className="text-[13px] text-muted hover:text-accent">
          {t('Back to {name}', { name: site?.name ?? '' })}
        </Link>
        <h1>{t('Members')}</h1>
        <p className="text-muted">
          {t('Choose who can open this site. Viewers read. Editors save drafts, and publish too unless the site requires review. Publishers also publish drafts and delete. Admins see every site.')}
        </p>
      </div>
      <div className="panel">
        <ul className="divide-y divide-line">
          {members.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-5 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-canvas text-xs font-semibold text-muted">{u.name.charAt(0).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{u.name}</div>
                <div className="truncate text-xs text-muted">{u.email}</div>
              </div>
              <select className="field w-40 py-1" value={roleOf(u.id)} onChange={(e) => setRole(u.id, e.target.value)} aria-label={t('Role of {name}', { name: u.name })}>
                <option value="">{t('No access')}</option>
                {(['viewer', 'editor', 'publisher'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(roleNames[r])}
                  </option>
                ))}
              </select>
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-5 py-6 text-center text-[13px] text-muted">
              {noUser[0]}
              <Link to="/admin/users" className="text-accent hover:underline">
                {t('Create a user')}
              </Link>
              {noUser[1]}
            </li>
          )}
        </ul>
        <div className="flex items-center justify-end gap-3 border-t border-line bg-canvas/60 px-5 py-3">
          {error && <span className="text-[13px] text-danger">{error}</span>}
          {status && <span className="text-[13px] text-ok">{status}</span>}
          <button className="btn btn-primary" onClick={() => run('save', save)} disabled={!!pending}>
            <Pending on={!!pending}>{t(pending ? 'Saving…' : 'Save members')}</Pending>
          </button>
        </div>
      </div>
    </div>
  );
}
