import { describe, expect, it } from 'vite-plus/test';

import { playerColors } from './player-colors';

describe('playerColors', () => {
  it('gives the first player red sabers, the left one deeper', () => {
    const { left, right } = playerColors(0);
    expect(left[0]).toBeCloseTo(0.84);
    expect(left[1]).toBeCloseTo(0);
    expect(left[2]).toBeCloseTo(0);
    expect(right[0]).toBeCloseTo(1);
    expect(right[1]).toBeCloseTo(0.4);
    expect(right[2]).toBeCloseTo(0.4);
  });

  it('keeps every channel in range and gives each player a different colour', () => {
    const colors = Array.from({ length: 32 }, (_, index) => playerColors(index));
    for (const { left, right } of colors) {
      for (const channel of [...left, ...right]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    expect(new Set(colors.map(({ left }) => left.map((channel) => channel.toFixed(3)).join())).size).toBe(32);
  });
});
