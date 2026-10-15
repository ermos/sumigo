import type { Collection, EntrySummary } from './api';

// View is how a user lists a collection, saved per user and collection.
export interface View {
  columns: string[];
  sort: { field: string; desc: boolean };
  filters: { field: string; value: string }[];
  pageSize: number;
}

export const pageSizes = [25, 50, 100];

// listable fields show as a column, sort and filter: the long or nested ones do not fit a row.
export const listable = (c: Collection) => c.fields.filter((f) => !['markdown', 'object', 'json', 'hidden'].includes(f.widget));

export const defaultView = (c: Collection): View => ({
  columns: c.fields.some((f) => f.name === 'date') ? ['date'] : [],
  sort: { field: 'date', desc: true },
  filters: [],
  pageSize: pageSizes[0],
});

export const cell = (e: EntrySummary, field: string): unknown => (field === 'title' ? e.title : e.data?.[field]);

export const text = (v: unknown): string => (v == null || typeof v === 'object' ? (Array.isArray(v) ? v.map(text).join(', ') : '') : String(v));

// applyView keeps the entries matching the search and every filter, sorted. Filters match a part of the value, any case.
export function applyView(entries: EntrySummary[], view: View, search: string) {
  const q = search.toLowerCase();
  const filters = view.filters.filter((f) => f.value);
  const { field, desc } = view.sort;
  return entries
    .filter((e) => (e.title.toLowerCase().includes(q) || e.slug.includes(q)) && filters.every((f) => text(cell(e, f.field)).toLowerCase().includes(f.value.toLowerCase())))
    .sort(
      (a, b) =>
        text(cell(a, field)).localeCompare(text(cell(b, field)), undefined, {
          numeric: true,
        }) * (desc ? -1 : 1),
    );
}
