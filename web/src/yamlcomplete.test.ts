// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggest } from './yamlcomplete.ts';

const doc = `media_folder: public/images
collections:
  - name: blog
    folder: src/content/blog
    seo:
      title: title
    fields:
      - { name: title, widget: string }
      - { name: summary, widget: text }
`;
const at = (above: string, before: string, explicit = true) => suggest(above, before, doc + above + before, explicit);

test('keys follow the key they sit under', () => {
  assert.ok(at('', 'col')?.labels.includes('collections'));
  assert.ok(at('collections:\n', '  - ')?.labels.includes('folder'));
  assert.ok(at('collections:\n  - name: blog\n    seo:\n', '      ')?.labels.includes('keywords'));
  assert.ok(at('collections:\n  - name: blog\n    fields:\n', '      - ')?.labels.includes('widget'));
});

test('values: widgets, booleans and field names for seo', () => {
  assert.deepEqual(at('', '      - { name: cover, widget: ima')?.labels.includes('image'), true);
  assert.equal(at('', '      - { name: cover, widget: ima')?.back, 3);
  assert.deepEqual(at('', '    create: ')?.labels, ['true', 'false']);
  const seo = at('collections:\n  - name: blog\n    seo:\n', '      description: ');
  assert.ok(seo?.labels.includes('summary') && seo.labels.includes('title'), JSON.stringify(seo));
});

test('flow map keys are field keys', () => {
  assert.ok(at('', '      - { name: x, re')?.labels.includes('required'));
});
