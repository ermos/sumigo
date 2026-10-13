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
  branch: string;
  workflow: 'direct' | 'pr';
  has_token: boolean;
  role?: Role;
  token?: string;
}

export interface SiteDetail extends Site {
  config: Config | null;
  config_error?: string;
}

export interface Pull {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  user: { login: string };
  updated_at: string;
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

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch('/api' + path, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new HttpError(res.status, err.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const can = (role: Role | undefined, min: Role) => {
  const rank = { viewer: 1, editor: 2, publisher: 3 };
  return !!role && rank[role] >= rank[min];
};

export interface MediaFile {
  name: string;
  size: number;
  url: string;
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
