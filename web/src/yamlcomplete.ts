// Completion of sumigo.yml keys and values, by context. Pure, so it runs under node --test.

// Keys of sumigo.yml by the key they sit under, with a short help shown next to the completion.
export const keys: Record<string, Record<string, string>> = {
  '': { media_folder: 'Repository folder of uploads', public_folder: 'URL prefix of uploads', collections: 'Folders of entries', i18n: 'Languages of translated collections' },
  i18n: {
    structure: 'multiple_folders (posts/fr/hi.md) or multiple_files (posts/hi.fr.md)',
    locales: 'Language codes, like [en, fr]',
    default_locale: 'First locale by default',
  },
  collections: {
    name: 'Unique id, no slash',
    label: 'Name shown in the UI',
    folder: 'Repository folder of the entries',
    extension: 'File extension, md by default',
    slug: 'File name template, {{slug}} by default',
    identifier_field: 'Field used as the title',
    create: 'false prevents new entries',
    seo: 'SEO analysis of the entries',
    i18n: 'true stores each entry per locale',
    fields: 'Fields of the entries',
  },
  fields: {
    name: 'Front matter key, body for the content',
    label: 'Name shown in the editor',
    widget: 'Editor input',
    required: 'false makes it optional',
    default: 'Value of new entries',
    options: 'Choices of a select',
    fields: 'Fields of an object',
    collection: 'Collection a relation points to',
    value_field: 'Stored value of a relation, {{slug}} by default',
    display_fields: 'Fields shown to pick a relation',
    multiple: 'true picks several entries',
    i18n: 'true translated, duplicate copied from the default locale',
  },
  seo: {
    title: 'Field of the meta title',
    description: 'Field of the meta description',
    keywords: 'Field of the keywords, the first one is the focus keyword',
    image: 'Field of the share image',
    slug: 'Check the focus keyword in the URL',
  },
};
const widgets = ['string', 'text', 'markdown', 'date', 'datetime', 'boolean', 'number', 'select', 'list', 'image', 'hidden', 'object', 'relation'];
const booleans = ['required', 'create', 'slug', 'multiple'];

const indentOf = (line: string) => line.length - line.trimStart().replace(/^-\s*/, '').length;

// parentKey finds the key the cursor line belongs to: the closest line above with a smaller indent, ending with "key:".
function parentKey(lines: string[], indent: number) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const m = l.match(/^\s*(?:-\s*)?(\w+):\s*$/);
    if (indentOf(l) < indent && m) return m[1];
    if (l.search(/\S/) < indent && !l.trimStart().startsWith('-') && !m) return '';
  }
  return '';
}

export interface Suggestion {
  // back is how many characters before the cursor the completed word starts.
  back: number;
  labels: string[];
  // help is set for keys: completing "name" writes "name: ".
  help?: Record<string, string>;
}

// suggest lists the completions at the cursor, from the lines above it, the cursor line up to the cursor, and the whole document.
export function suggest(above: string, before: string, doc: string, explicit = false): Suggestion | null {
  const options = (labels: string[], back: number, help?: Record<string, string>): Suggestion => ({ back, labels, help });

  // A value: "widget: mark|", also inside a flow map "{ name: x, widget: |".
  const value = before.match(/(\w+):\s*([\w-]*)$/);
  if (value) {
    const from = value[2].length;
    if (value[1] === 'widget') return options(widgets, from);
    if (booleans.includes(value[1])) return options(['true', 'false'], from);
    if (value[1] === 'i18n') return options(['true', 'false', 'duplicate'], from);
    if (value[1] === 'structure') return options(['multiple_folders', 'multiple_files'], from);
    if (['title', 'description', 'keywords', 'image'].includes(value[1]) && parentKey(above.split('\n'), indentOf(before)) === 'seo') {
      const names = [...doc.matchAll(/(?:^|[{,\s])name:\s*([\w-]+)/g)].map((m) => m[1]);
      return options([...new Set(names)], from);
    }
    return null;
  }
  // A key of a flow map: "{ name: title, wi|" is a field.
  const flow = before.match(/[{,]\s*(\w*)$/);
  if (flow) return options(Object.keys(keys.fields), flow[1].length, keys.fields);
  // A key on its own line.
  const key = before.match(/^(\s*(?:-\s*)?)(\w*)$/);
  if (!key || (!key[2] && !explicit && !key[1].includes('-'))) return null;
  const parent = parentKey(above.split('\n'), key[1].length);
  const help = keys[parent] ?? {};
  return options(Object.keys(help), key[2].length, help);
}
