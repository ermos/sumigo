import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyView, type View } from './listview.ts';

const entry = (slug: string, data: Record<string, unknown>) => ({
  slug,
  path: '',
  title: String(data.title),
  data,
});

test('a view filters on every field, then sorts', () => {
  const entries = [
    entry('a', { title: 'Post 10', tags: ['go', 'web'], draft: false }),
    entry('b', { title: 'Post 9', tags: ['go'], draft: true }),
    entry('c', { title: 'Other', tags: ['Go'], draft: false }),
  ];
  const view: View = {
    columns: [],
    sort: { field: 'title', desc: false },
    filters: [
      { field: 'tags', value: 'GO' },
      { field: 'draft', value: 'false' },
    ],
    pageSize: 25,
  };
  assert.deepEqual(
    applyView(entries, view, '').map((e) => e.slug),
    ['c', 'a'],
  );
  assert.deepEqual(
    applyView(entries, { ...view, filters: [], sort: { field: 'title', desc: true } }, 'post').map((e) => e.slug),
    ['a', 'b'],
  );
});
