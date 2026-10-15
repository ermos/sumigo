import { tError } from './i18n';

export type Role = 'viewer' | 'editor' | 'publisher';

export interface User {
  id: number;
  email: string;
  // name is "first_name last_name", it signs the commits.
  name: string;
  first_name: string;
  last_name: string;
  is_admin: boolean;
  // must_change_password: logged in with a temporary password, a new one must be chosen first.
  must_change_password?: boolean;
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
  // collection, value_field, display_fields and multiple set up a relation field.
  collection?: string;
  value_field?: string;
  display_fields?: string[];
  multiple?: boolean;
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
  // seo turns on the SEO panel and names the fields playing each role.
  seo?: { title?: string; description?: string; keywords?: string; image?: string; slug?: boolean };
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

export interface SiteDetail extends Site {
  config: Config | null;
  config_error?: string;
  // config_missing offers the onboarding: the repository has no sumigo.yml yet.
  config_missing?: boolean;
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

export interface OIDCSettings {
  enabled: boolean;
  issuer: string;
  label: string;
  client_id: string;
  client_secret?: string;
  has_secret: boolean;
  auto_create: boolean;
  admin_group: string;
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
    public params?: Record<string, string>,
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
      throw new HttpError(res.status, tError(err.code, err.params, err.error ?? res.statusText), err.params);
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

const MAX_SIDE = 2000;

// optimizeImage resizes a photo to MAX_SIDE and re-encodes it as WebP; drawing on a canvas drops all metadata (EXIF, GPS).
// ponytail: GIF (animation) and SVG (vector) are sent as is; browsers without WebP encoding get JPEG, or the original PNG.
export const optimizeImage = async (file: File): Promise<File> => {
  if (!/^image\/(jpeg|png|webp|avif|bmp)$/.test(file.type)) return file;
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  const encode = (type: string) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, 0.82));
  let blob = await encode('image/webp');
  if (blob?.type !== 'image/webp') blob = file.type === 'image/png' ? null : await encode('image/jpeg'); // JPEG would lose PNG transparency
  if (!blob) return file;
  const ext = blob.type === 'image/webp' ? '.webp' : '.jpg';
  return new File([blob], file.name.replace(/\.[^.]*$/, '') + ext, { type: blob.type });
};

export const uploadMedia = async (siteId: number, file: File) => {
  const form = new FormData();
  form.append('file', await optimizeImage(file));
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
