// SEO analysis of an entry, computed in the browser as the user types. No i18n here: each check
// carries an English message key and its variables, translated by the panel (and testable with node --test).

export type Status = 'good' | 'warn' | 'bad';

export interface Check {
  status: Status;
  // message is an English i18n key, vars fill its {placeholders}.
  message: string;
  vars?: Record<string, string | number>;
}

export interface SEOInput {
  title: string;
  description?: string; // undefined when the collection has no description field
  keywords: string[];
  slug?: string; // undefined when the slug is not checked
  body: string;
  image?: string | null; // null when the collection has no image field
}

export interface SEOResult {
  checks: Check[];
  score: number; // 0 to 100
  words: number;
  density: number; // focus keyword, percent of the words
}

// fold makes matching ignore case and accents: "Éditeur" finds "editeur".
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const wordsOf = (s: string) => fold(s).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];

// contains looks for the keyword as whole words: "art" is not found in "party".
const contains = (text: string, keyword: string) => count(wordsOf(text), wordsOf(keyword)) > 0;

function count(words: string[], phrase: string[]) {
  if (!phrase.length) return 0;
  let n = 0;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((w, j) => words[i + j] === w)) n++;
  }
  return n;
}

// plainText drops the Markdown syntax that is not read: code, image and link targets, HTML tags.
export const plainText = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#+\s*/gm, '');

// keywordsOf reads a keywords field: a list, or a comma separated string.
export const keywordsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []).map((k) => k.trim()).filter(Boolean);

const range = (n: number, good: [number, number], warn: [number, number]): Status => (n >= good[0] && n <= good[1] ? 'good' : n >= warn[0] && n <= warn[1] ? 'warn' : 'bad');

export function analyze(input: SEOInput): SEOResult {
  const checks: Check[] = [];
  const add = (status: Status, message: string, vars?: Check['vars']) => checks.push({ status, message, vars });
  const focus = input.keywords[0] ?? '';
  const text = plainText(input.body);
  const words = wordsOf(text);
  const density = focus && words.length ? (count(words, wordsOf(focus)) * 100) / words.length : 0;

  if (!focus) add('bad', 'Add a focus keyword: the first keyword is the one checked.');

  const tl = input.title.trim().length;
  add(range(tl, [30, 60], [15, 70]), 'Title: {n} characters, 30 to 60 recommended.', { n: tl });
  if (focus) add(contains(input.title, focus) ? 'good' : 'bad', 'Focus keyword in the title.');

  if (input.description !== undefined) {
    const dl = input.description.trim().length;
    add(range(dl, [120, 160], [70, 180]), 'Description: {n} characters, 120 to 160 recommended.', { n: dl });
    if (focus) add(contains(input.description, focus) ? 'good' : 'bad', 'Focus keyword in the description.');
  }
  if (focus && input.slug !== undefined) add(contains(input.slug.replace(/[-_]/g, ' '), focus) ? 'good' : 'warn', 'Focus keyword in the URL.');
  if (focus) {
    add(contains(words.slice(0, 100).join(' '), focus) ? 'good' : 'warn', 'Focus keyword in the introduction (first 100 words).');
    const d = Math.round(density * 10) / 10;
    if (density === 0) add('bad', 'Focus keyword never used in the content.');
    else if (density < 0.5) add('warn', 'Focus keyword density: {d}%, use it a bit more (0.5 to 2.5%).', { d });
    else if (density > 2.5) add('warn', 'Focus keyword density: {d}%, too repetitive (0.5 to 2.5%).', { d });
    else add('good', 'Focus keyword density: {d}%.', { d });
  }

  add(words.length >= 600 ? 'good' : words.length >= 300 ? 'warn' : 'bad', 'Content: {n} words, 600 or more recommended.', { n: words.length });
  const h2 = (input.body.match(/^#{2,3}\s+\S/gm) ?? []).length;
  add(h2 ? 'good' : 'warn', 'Subheadings (H2, H3): {n}.', { n: h2 });
  if (/^#\s+\S/m.test(input.body)) add('warn', 'The content has a H1 heading: the title already is the H1, use H2.');
  const images = input.body.match(/!\[[^\]]*\]\(/g) ?? [];
  const noAlt = images.filter((i) => /^!\[\s*\]/.test(i)).length;
  if (images.length) add(noAlt ? 'bad' : 'good', noAlt ? 'Images without alternative text: {n}.' : 'Every image has an alternative text.', { n: noAlt });
  const links = (input.body.match(/(^|[^!])\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  add(links ? 'good' : 'warn', 'Links in the content: {n}.', { n: links });
  if (input.image !== null && input.image !== undefined) add(input.image ? 'good' : 'warn', input.image ? 'Share image set.' : 'No share image: social networks will pick one.');

  const points = checks.reduce((s, c) => s + (c.status === 'good' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return { checks, score: Math.round((points * 100) / checks.length), words: words.length, density };
}

// slugify approximates the slug the server builds from the title, for entries not saved yet.
export const slugify = (s: string) =>
  fold(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
