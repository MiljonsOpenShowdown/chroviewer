import { expect, test } from 'vite-plus/test';

import type { Replay } from '../../core/replay/types';
import { findBrMismatch } from './br-validate';

function player(label: string, mapHash: string, difficulty = 9, characteristic = 'Standard') {
  return { label, mapHash, replay: { metadata: { difficulty, characteristic } } as Replay };
}

test('accepts replays on the same map, difficulty and characteristic', () => {
  expect(findBrMismatch([player('A', 'ABC'), player('B', 'abc', 9, 'standard'), player('C', 'ABC')])).toBeNull();
});

test('accepts a single player and an empty list', () => {
  expect(findBrMismatch([player('A', 'ABC')])).toBeNull();
  expect(findBrMismatch([])).toBeNull();
});

test('names the replay on a different map', () => {
  expect(findBrMismatch([player('A', 'ABC'), player('B', 'ABC'), player('C', 'DEF')])).toEqual({
    label: 'C',
    referenceLabel: 'A',
    field: 'map',
    expected: 'ABC',
    actual: 'DEF',
  });
});

test('names the replay on a different difficulty', () => {
  expect(findBrMismatch([player('A', 'ABC', 9), player('B', 'ABC', 7)])).toMatchObject({
    label: 'B',
    field: 'difficulty',
    expected: '9',
    actual: '7',
  });
});

test('names the replay on a different characteristic', () => {
  expect(findBrMismatch([player('A', 'ABC', 9, 'Standard'), player('B', 'ABC', 9, 'OneSaber')])).toMatchObject({
    label: 'B',
    field: 'characteristic',
  });
});
