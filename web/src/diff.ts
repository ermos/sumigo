// A part of a text diff: kept as is, or changed from old to new (one side empty for a pure insertion or deletion).
export type Part = { same: true; text: string } | { same: false; old: string; new: string };

// Words, runs of spaces and single punctuation marks, so a fixed typo shows as one word.
const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu) ?? [];
const lines = (s: string) => s.split(/(?<=\n)/);

// ponytail: LCS table is O(n·m), fine per line and per paragraph; bigger inputs fall back to one change, Myers if that shows up.
const MAX_CELLS = 2_000_000;

function lcs(a: string[], b: string[]): Part[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [{ same: false, old: a.join(''), new: b.join('') }];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const parts: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push(parts, { same: true, text: a[i++] });
      j++;
    } else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) push(parts, { same: false, old: '', new: b[j++] });
    else push(parts, { same: false, old: a[i++], new: '' });
  }
  return parts;
}

// push appends a part, merging it into the last one when they are of the same kind.
function push(parts: Part[], p: Part) {
  const last = parts[parts.length - 1];
  if (last?.same && p.same) last.text += p.text;
  else if (last && !last.same && !p.same) {
    last.old += p.old;
    last.new += p.new;
  } else parts.push(p);
}

// diffText compares line by line, then word by word inside changed lines.
// Spaces alone between two changes join them, so "teh  quik" → "the quick" reads as one edit.
export function diffText(a: string, b: string): Part[] {
  const out: Part[] = [];
  for (const p of lcs(lines(a), lines(b))) {
    if (p.same || !p.old || !p.new) push(out, p);
    else for (const w of lcs(tokens(p.old), tokens(p.new))) push(out, w);
  }
  const merged: Part[] = [];
  out.forEach((p, k) => {
    const prev = merged[merged.length - 1];
    const next = out[k + 1];
    if (p.same && /^[ \t]+$/.test(p.text) && prev && !prev.same && next && !next.same) push(merged, { same: false, old: p.text, new: p.text });
    else push(merged, p);
  });
  return merged;
}
