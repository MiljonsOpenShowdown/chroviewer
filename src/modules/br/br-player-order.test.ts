import { expect, test } from 'vite-plus/test';

import { brPlayerOrder } from './br-player-order';

test('orders players by score, highest first', () => {
  expect(brPlayerOrder([100, 300, 200])).toEqual([1, 2, 0]);
});

test('keeps entry order on ties', () => {
  expect(brPlayerOrder([0, 0, 0])).toEqual([0, 1, 2]);
  expect(brPlayerOrder([50, 200, 50, 200])).toEqual([1, 3, 0, 2]);
});

test('handles no players', () => {
  expect(brPlayerOrder([])).toEqual([]);
});
