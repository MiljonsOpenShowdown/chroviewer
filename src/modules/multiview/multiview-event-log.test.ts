import { describe, expect, test } from 'vite-plus/test';

import { MultiviewEventLog } from './multiview-event-log';

describe('MultiviewEventLog', () => {
  test('is empty until something happens', () => {
    expect(new MultiviewEventLog().take()).toBeNull();
  });

  test('sums chunks per tile, with the song times of the first and last', () => {
    const log = new MultiviewEventLog();
    log.add('a', '1', { type: 'chunk', frames: 9, songTime: 10.1234, gap: 0 }, 100);
    log.add('a', '1', { type: 'chunk', frames: 9, songTime: 10.25, gap: 2 }, 200);
    log.add('b', '2', { type: 'chunk', frames: 8, songTime: 4, gap: 0 }, 150);
    expect(log.take()).toEqual([
      { type: 'chunks', count: 1, frames: 8, from: 4, to: 4, gaps: 0, tileId: 'b', playerId: '2', at: 150 },
      { type: 'chunks', count: 2, frames: 18, from: 10.123, to: 10.25, gaps: 2, tileId: 'a', playerId: '1', at: 200 },
    ]);
    expect(log.take()).toBeNull();
  });

  test('keeps other events as they are, oldest first, and marks connection seeks', () => {
    const log = new MultiviewEventLog();
    log.add('a', '1', { type: 'status', status: 'watching' }, 300);
    log.add('a', '1', { type: 'seek', from: 1, to: 2.00049 }, 200);
    log.add('a', '1', { type: 'seek', from: 1, to: 3, reason: 'sync' }, 250);
    expect(log.take()).toEqual([
      { type: 'seek', from: 1, to: 2, reason: 'live', tileId: 'a', playerId: '1', at: 200 },
      { type: 'seek', from: 1, to: 3, reason: 'sync', tileId: 'a', playerId: '1', at: 250 },
      { type: 'status', status: 'watching', tileId: 'a', playerId: '1', at: 300 },
    ]);
  });

  test('counts what goes over its limits', () => {
    const log = new MultiviewEventLog();
    for (let index = 0; index < 15; index++)
      log.add(null, null, { type: 'console', level: 'warn', message: `warning ${index}` }, index);
    for (let index = 0; index < 100; index++) log.add('a', '1', { type: 'pause', songTime: index }, 100 + index);
    const events = log.take() ?? [];
    expect(events.filter((event) => event.type === 'console')).toHaveLength(10);
    expect(events).toHaveLength(101);
    expect(events.at(-1)).toEqual({ type: 'dropped', count: 15, tileId: null, playerId: null, at: expect.any(Number) });
    // A new message starts the limits over
    log.add(null, null, { type: 'console', level: 'error', message: 'again' }, 1);
    expect(log.take()).toHaveLength(1);
  });

  test('cuts long texts short', () => {
    const log = new MultiviewEventLog();
    log.add('a', '1', { type: 'warning', message: 'x'.repeat(400) }, 1);
    expect(log.take()).toEqual([{ type: 'warning', message: 'x'.repeat(300), tileId: 'a', playerId: '1', at: 1 }]);
  });
});
