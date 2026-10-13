import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Access, api, Role, Site, User } from './api';
import { useCtx } from './App';

const emptySite: Site = { id: 0, name: '', repo: '', branch: 'main', workflow: 'direct', has_token: false };

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
      setStatus('Saved');
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
      setStatus(`GitHub access OK, sumigo.yml loaded with ${res.collections} collection(s)`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete site ${site.name}? The repository is not touched.`)) return;
    await api('DELETE', `/sites/${site.id}`);
    reloadSites();
    navigate('/');
  };

  return (
    <>
      <h1>{site.id ? `Settings · ${site.name}` : 'New site'}</h1>
      <form className="card form" onSubmit={save}>
        <label>
          Name
          <input value={site.name} onChange={set('name')} required />
        </label>
        <div className="row">
          <label>
            Repository (owner/name)
            <input value={site.repo} onChange={set('repo')} placeholder="acme/blog" required />
          </label>
          <label>
            Branch
            <input value={site.branch} onChange={set('branch')} required />
          </label>
        </div>
        <label>
          GitHub token {site.has_token && <span className="muted small">(set, leave empty to keep)</span>}
          <input type="password" value={site.token ?? ''} onChange={set('token')} placeholder="github_pat_…" autoComplete="off" />
          <span className="muted small">
            Fine-grained token with Contents and Pull requests read/write on this repository.{' '}
            {tokenURL(site.repo) ? (
              <>
                <a href={tokenURL(site.repo)} target="_blank" rel="noreferrer">
                  Create it on GitHub
                </a>{' '}
                (permissions are prefilled, select only <strong>{site.repo}</strong> under "Repository access").
              </>
            ) : (
              'Fill the repository to get a prefilled GitHub link.'
            )}
          </span>
        </label>
        <label>
          Workflow
          <select value={site.workflow} onChange={set('workflow')}>
            <option value="direct">Direct: every save commits to the branch</option>
            <option value="pr">Review: saves open a pull request, publishers merge it</option>
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        {status && <p className="ok">{status}</p>}
        <div className="actions">
          {site.id > 0 && (
            <>
              <button type="button" className="danger" onClick={remove}>
                Delete
              </button>
              <button type="button" onClick={check}>
                Test GitHub access
              </button>
            </>
          )}
          <button className="primary">Save</button>
        </div>
      </form>
      {site.id > 0 && <AccessEditor siteId={site.id} />}
    </>
  );
}

function AccessEditor({ siteId }: { siteId: number }) {
  const [users, setUsers] = useState<User[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [status, setStatus] = useState('');

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
    await api('PUT', `/sites/${siteId}/access`, access);
    setStatus('Access saved');
  };

  return (
    <div className="card">
      <h2>Access</h2>
      <p className="muted small">Viewer reads, editor writes (or opens PRs in review workflow), publisher also merges and deletes. Admins have full access everywhere.</p>
      <table>
        <tbody>
          {users
            .filter((u) => !u.is_admin)
            .map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>
                  <select value={roleOf(u.id)} onChange={(e) => setRole(u.id, e.target.value)}>
                    <option value="">No access</option>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="publisher">Publisher</option>
                  </select>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="actions">
        {status && <span className="ok small">{status}</span>}
        <button className="primary" onClick={save}>
          Save access
        </button>
      </div>
    </div>
  );
}

export function Users() {
  const { me } = useCtx();
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

  const remove = async (u: User) => {
    if (!confirm(`Delete ${u.name}?`)) return;
    await api('DELETE', `/users/${u.id}`);
    load();
  };

  return (
    <>
      <div className="toolbar">
        <h1>Users</h1>
        <button className="primary" onClick={() => setEditing({ id: 0, email: '', name: '', is_admin: false, password: '' })}>
          New user
        </button>
      </div>
      {editing && (
        <form className="card form" onSubmit={save}>
          <div className="row">
            <label>
              Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            </label>
            <label>
              Email (used as commit author)
              <input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
            </label>
          </div>
          <label>
            Password {editing.id > 0 && <span className="muted small">(leave empty to keep)</span>}
            <input type="password" value={editing.password} minLength={8} required={!editing.id} onChange={(e) => setEditing({ ...editing, password: e.target.value })} autoComplete="new-password" />
          </label>
          <label className="check">
            <input type="checkbox" checked={editing.is_admin} onChange={(e) => setEditing({ ...editing, is_admin: e.target.checked })} /> Administrator
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="primary">Save</button>
          </div>
        </form>
      )}
      <table className="card">
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="muted">{u.email}</td>
              <td>{u.is_admin && <span className="badge">admin</span>}</td>
              <td className="actions">
                <button className="link" onClick={() => setEditing({ ...u, password: '' })}>
                  Edit
                </button>
                {u.id !== me.id && (
                  <button className="link danger" onClick={() => remove(u)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
