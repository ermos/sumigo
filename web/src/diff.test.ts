// Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffText } from './diff.ts';

test('a fixed word is one change between unchanged text', () => {
  assert.deepEqual(diffText('I has a cat.\nIt sleep.\n', 'I have a cat.\nIt sleeps.\n'), [
    { same: true, text: 'I ' },
    { same: false, old: 'has', new: 'have' },
    { same: true, text: ' a cat.\nIt ' },
    { same: false, old: 'sleep', new: 'sleeps' },
    { same: true, text: '.\n' },
  ]);
});

test('neighbour edits separated by a space read as one', () => {
  assert.deepEqual(diffText('teh quik fox', 'the quick fox'), [
    { same: false, old: 'teh quik', new: 'the quick' },
    { same: true, text: ' fox' },
  ]);
});

test('insertions, deletions and identical texts', () => {
  assert.deepEqual(diffText('a b', 'a b'), [{ same: true, text: 'a b' }]);
  assert.deepEqual(diffText('one\n', 'one\ntwo\n'), [
    { same: true, text: 'one\n' },
    { same: false, old: '', new: 'two\n' },
  ]);
  assert.deepEqual(diffText('very big', 'big'), [
    { same: false, old: 'very ', new: '' },
    { same: true, text: 'big' },
  ]);
});
