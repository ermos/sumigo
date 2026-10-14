import { tError } from './i18n';

export type Role = 'viewer' | 'editor' | 'publisher';

export interface User {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
}

export type Option = string | { label: string; value: string };

export interface Field {
  name: string;
  label?: string;
  widget: string;
  required?: boolean;
  options?: Option[];
  default?: unknown;
  fields?: Field[];
}

export interface Collection {
  name: string;
  label?: string;
  folder: string;
  extension?: string;
  slug?: string;
  identifier_field?: string;
  create?: boolean;
  fields: Field[];
}

export interface Config {
  media_folder: string;
  public_folder: string;
  collections: Collection[];
}

export interface Site {
  id: number;
  name: string;
  repo: string;
  forge: Forge;
  // forge_url is the instance, empty for github.com and gitlab.com.
  forge_url: string;
  branch: string;
  workflow: 'direct' | 'pr';
  has_token: boolean;
  ai_enabled: boolean;
  role?: Role;
  token?: string;
}

export type Forge = 'github' | 'gitlab' | 'gitea';

export const forgeNames: Record<Forge, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Forgejo / Gitea' };

// forgeURL is the web URL of the instance hosting the site.
export const forgeURL = (site: Pick<Site, 'forge' | 'forge_url'>) => site.forge_url || (site.forge === 'gitlab' ? 'https://gitlab.com' : 'https://github.com');

// treeURL links to the files of the site branch on its forge.
export const treeURL = (site: Site) => `${forgeURL(site)}/${site.repo}/${{ github: 'tree', gitlab: '-/tree', gitea: 'src/branch' }[site.forge]}/${site.branch}`;

export interface SiteDetail extends Site {
  config: Config | null;
  config_error?: string;
  // ai is true when the assistant is on for the instance and this site.
  ai: boolean;
}

export interface Pull {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  user: { login: string };
  updated_at: string;
  scheduled_at?: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface AISettings {
  enabled: boolean;
  provider: string;
  model: string;
  base_url: string;
  api_key?: string;
  has_key: boolean;
}

export interface EntrySummary {
  slug: string;
  path: string;
  title: string;
  date?: string;
  draft?: Pull;
  data?: Record<string, unknown>;
}

export interface Entry {
  slug: string;
  data: Record<string, unknown>;
  draft: Pull | null;
}

export interface Access {
  user_id: number;
  role: Role;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Writes in flight, shown as a progress bar: GitHub commits can take a few seconds.
let writes = 0;
const writeListeners = new Set<() => void>();
const setWrites = (n: number) => {
  writes = n;
  writeListeners.forEach((l) => l());
};
export const pendingWrites = {
  subscribe: (l: () => void) => (writeListeners.add(l), () => writeListeners.delete(l)),
  get: () => writes,
};

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const write = method !== 'GET';
  if (write) setWrites(writes + 1);
  try {
    const res = await fetch('/api' + path, {
      method,
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new HttpError(res.status, tError(err.code, err.params, err.error ?? res.statusText));
    }
    return res.status === 204 ? (undefined as T) : await res.json();
  } finally {
    if (write) setWrites(writes - 1);
  }
}

export const can = (role: Role | undefined, min: Role) => {
  const rank = { viewer: 1, editor: 2, publisher: 3 };
  return !!role && rank[role] >= rank[min];
};

export interface MediaFile {
  name: string;
  size: number;
  url: string;
  used: boolean;
}

export const uploadMedia = async (siteId: number, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return (await api<{ url: string }>('POST', `/sites/${siteId}/media`, form)).url;
};

// mediaSrc maps a site URL from the media folder (e.g. /images/cat.png) to the CMS proxy, so it shows even for private repos.
export const mediaSrc = (site: { id: number; config: Config | null }, url: string) => {
  const cfg = site.config;
  const pub = '/' + (cfg?.public_folder || cfg?.media_folder || '').replace(/^\/+|\/+$/g, '');
  if (!cfg?.media_folder || !url.startsWith(pub + '/')) return url;
  const name = url.slice(pub.length + 1);
  return name.includes('/') ? url : `/api/sites/${site.id}/media/${encodeURIComponent(name)}`;
};
