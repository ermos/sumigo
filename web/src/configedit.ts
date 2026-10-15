// Edits of sumigo.yml from the form. Pure, so it runs under node --test.
import { Document, isMap, isScalar, YAMLSeq } from 'yaml';

export type Path = (string | number)[];

// Edit writes into the YAML document in place, so comments and keys the form does not know survive.
export function editor(doc: Document, onChange: () => void) {
  const set = (path: Path, v: unknown) => {
    const node = doc.getIn(path, true);
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
      if (doc.hasIn(path)) doc.deleteIn(path);
      // An emptied map under a key (seo, i18n) goes too. Maps in a list are entries, they stay.
      for (let p = path.slice(0, -1); p.length && typeof p[p.length - 1] === 'string'; p = p.slice(0, -1)) {
        const m = doc.getIn(p, true);
        if (!isMap(m) || m.items.length) break;
        doc.deleteIn(p);
      }
    } else if (isScalar(node) && !Array.isArray(v) && typeof v !== 'object') node.value = v;
    else doc.setIn(path, doc.createNode(v, { flow: Array.isArray(v) && v.every((x) => typeof x !== 'object') }));
    onChange();
  };
  const push = (path: Path, v: unknown) => {
    if (doc.hasIn(path)) doc.addIn(path, doc.createNode(v));
    else doc.setIn(path, doc.createNode([v]));
    onChange();
  };
  const del = (path: Path) => set(path, undefined);
  const move = (path: Path, i: number, j: number) => {
    const items = (doc.getIn(path, true) as YAMLSeq).items;
    [items[i], items[j]] = [items[j], items[i]];
    onChange();
  };
  return { set, push, del, move };
}
export type Edit = ReturnType<typeof editor>;
