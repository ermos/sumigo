// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { editor } from './configedit.ts';

test('form edits keep comments and unknown keys, and prune emptied maps', () => {
  const doc = parseDocument(`# site config
media_folder: static # uploads
backend: { name: github }
collections:
  - name: posts
    folder: content/posts
    seo: { title: title }
    fields:
      - { name: title, widget: string }
      - { name: body, widget: markdown }
`);
  const edit = editor(doc, () => {});
  edit.set(['media_folder'], 'static/images');
  edit.set(['collections', 0, 'seo', 'title'], '');
  edit.move(['collections', 0, 'fields'], 0, 1);
  edit.push(['collections', 0, 'fields'], { name: 'date', widget: 'date' });
  edit.set(['collections', 0, 'fields', 2, 'name'], '');
  edit.push(['collections', 0, 'tags'], 'a');

  const out = doc.toString();
  assert.match(out, /# site config/);
  assert.match(out, /media_folder: static\/images # uploads/);
  assert.match(out, /backend: \{ name: github \}/);
  assert.doesNotMatch(out, /seo/);
  const col = (doc.toJS() as { collections: { fields: { name?: string }[]; tags: string[] }[] }).collections[0];
  assert.deepEqual(col.fields.map((f) => f.name), ['body', 'title', undefined]);
  assert.deepEqual(col.tags, ['a']);
});
