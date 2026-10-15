import { describe, expect, test, vi } from 'vite-plus/test';

import { createClock } from './song-clock';

function fixture(rate = 1, offset = 0) {
  let now = 0;
  const driver = { now: () => now, start: vi.fn(), stop: vi.fn(), setRate: vi.fn() };
  const clock = createClock(180, 120, driver);
  clock.setRate(rate);
  clock.setAudioOffset(offset);
  return {
    clock,
    driver,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

describe('continuous replay synchronization', () => {
  test('eight players converge without jumping backwards or restarting audio at two-second checks', () => {
    const players = Array.from({ length: 8 }, (_, index) => {
      const player = fixture(1, 0.2);
      player.clock.seek(10 + index * 0.05);
      player.clock.play();
      return player;
    });
    const previous = players.map(({ clock }) => clock.currentTime());
    for (let tick = 0; tick < 300; tick++) {
      for (const player of players) player.advance(0.1);
      const target = players[0]?.clock.currentTime() ?? 0;
      players.forEach(({ clock }, index) => {
        // Corrections run continuously after drift is observed, independently
        // of the two-second detection cadence.
        if (tick >= 20) clock.correctDrift(target);
        expect(clock.currentTime()).toBeGreaterThan(previous[index] ?? 0);
        expect(clock.currentTime() - (previous[index] ?? 0)).toBeLessThanOrEqual(0.100001);
        expect(clock.getRate()).toBeGreaterThanOrEqual(0.95);
        expect(clock.getRate()).toBeLessThanOrEqual(1.05);
        previous[index] = clock.currentTime();
      });
    }
    for (const { clock, driver } of players) {
      expect(clock.currentTime()).toBeCloseTo(players[0]?.clock.currentTime() ?? 0, 1);
      expect(driver.start).toHaveBeenCalledTimes(1);
      expect(driver.stop).not.toHaveBeenCalled();
      expect(clock.getRate()).toBe(1);
    }
  });

  test('corrects a lagging clock while preserving the nominal song speed', () => {
    const { clock, driver, advance } = fixture(1.2);
    clock.play();
    advance(1);
    const before = clock.currentTime();
    clock.correctDrift(before + 0.2);
    expect(clock.currentTime()).toBe(before);
    expect(clock.getRate()).toBeCloseTo(1.26);
    advance(1);
    expect(clock.currentTime()).toBeCloseTo(before + 1.26);
    clock.correctDrift(clock.currentTime());
    expect(clock.getRate()).toBe(1.2);
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.stop).not.toHaveBeenCalled();
  });

  test('pause and explicit seek end a temporary correction; invalid targets are ignored', () => {
    const { clock, advance } = fixture();
    clock.play();
    advance(5);
    clock.correctDrift(4);
    expect(clock.getRate()).toBe(0.95);
    clock.pause();
    expect(clock.getRate()).toBe(1);
    clock.play();
    clock.correctDrift(Number.NaN);
    expect(clock.getRate()).toBe(1);
    clock.correctDrift(4);
    clock.seek(10);
    expect(clock.getRate()).toBe(1);
    expect(clock.currentTime()).toBe(10);
  });
});
