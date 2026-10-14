// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, keywordsOf } from './seo.ts';

const statusOf = (r: ReturnType<typeof analyze>, message: string) => r.checks.find((c) => c.message === message)?.status;

test('a well optimized entry scores high, matching keywords without accents or case', () => {
  const intro = 'Le pickleball au Mans se joue toute l’année. ';
  const body = `${intro}${'Un club accueille les débutants et les joueurs confirmés chaque semaine. '.repeat(55)}\n\n## Où jouer au Pickleball au Mans\n\nVoir [les clubs](/clubs).\n`;
  const r = analyze({
    title: 'Où jouer au Pickleball au Mans : clubs et créneaux 2026',
    description: 'Tous les clubs pour jouer au pickleball au Mans et en Sarthe : horaires, tarifs et créneaux découverte pour débutants comme confirmés en 2026.',
    keywords: keywordsOf('PICKLEBALL AU MANS, sarthe'),
    slug: 'pickleball-au-mans',
    body,
    image: '/uploads/cover.webp',
  });
  assert.equal(statusOf(r, 'Focus keyword in the title.'), 'good');
  assert.equal(statusOf(r, 'Focus keyword in the URL.'), 'good');
  assert.equal(statusOf(r, 'Focus keyword in the introduction (first 100 words).'), 'good');
  assert.equal(statusOf(r, 'Focus keyword density: {d}%, use it a bit more (0.5 to 2.5%).'), 'warn');
  assert.ok(r.score >= 85, `score ${r.score}`);
});

test('missing keyword, short content and images without alt are flagged', () => {
  const r = analyze({ title: 'Hi', keywords: [], body: '# Big\n\n![](/a.png) party', image: '' });
  assert.equal(statusOf(r, 'Add a focus keyword: the first keyword is the one checked.'), 'bad');
  assert.equal(statusOf(r, 'Images without alternative text: {n}.'), 'bad');
  assert.equal(statusOf(r, 'The content has a H1 heading: the title already is the H1, use H2.'), 'warn');
  assert.equal(statusOf(r, 'No share image: social networks will pick one.'), 'warn');
  // A collection without description field gets no description check.
  assert.equal(statusOf(r, 'Description: {n} characters, 120 to 160 recommended.'), undefined);
  assert.ok(r.score < 40, `score ${r.score}`);
});

test('a keyword is matched as whole words only', () => {
  const r = analyze({ title: 'A party', keywords: ['art'], body: 'party', image: null });
  assert.equal(statusOf(r, 'Focus keyword in the title.'), 'bad');
});
