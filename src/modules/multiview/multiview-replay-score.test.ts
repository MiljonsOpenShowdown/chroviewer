import { describe, expect, test } from 'vite-plus/test';

import type { Replay, ReplayNoteEvent } from '../../core/replay/types';
import { multiviewReplayScore } from './multiview-replay-score';

const note = (time: number, eventType: number) => ({ time, eventType }) as ReplayNoteEvent;

// Only the event lists scoring reads; a live replay has the rest too
function replay(overrides: Partial<Replay> = {}) {
  return {
    notes: [note(1, 1), note(1.5, 1), note(2, 3), note(2.5, 2)],
    scores: [
      { score: 115, time: 1, immediateMaxPossibleScore: 115 },
      { score: 345, time: 1.5, immediateMaxPossibleScore: 345 },
    ],
    combos: [
      { combo: 1, time: 1 },
      { combo: 2, time: 1.5 },
      { combo: 0, time: 2 },
    ],
    multipliers: [],
    energies: [],
    walls: [],
    ...overrides,
  } as unknown as Replay;
}

describe('multiviewReplayScore', () => {
  test('is null without a replay or before its first score', () => {
    expect(multiviewReplayScore(null, 5)).toBeNull();
    expect(multiviewReplayScore(replay(), 0.9)).toBeNull();
    expect(multiviewReplayScore(replay({ scores: [] }), 5)).toBeNull();
  });

  test('is the score at the time shown, not the latest received', () => {
    expect(multiviewReplayScore(replay(), 1.2)).toEqual({
      score: 115,
      accuracy: 1,
      combo: 1,
      maxCombo: 1,
      notesMissed: 0,
      badCuts: 0,
      bombHits: 0,
      songPosition: 1.2,
    });
    expect(multiviewReplayScore(replay(), 1.5)).toMatchObject({ score: 345, combo: 2, maxCombo: 2 });
  });

  test('counts misses and bad cuts separately, as the realtime score does', () => {
    expect(multiviewReplayScore(replay(), 2.6)).toMatchObject({
      combo: 0,
      maxCombo: 2,
      notesMissed: 1,
      badCuts: 1,
    });
  });

  test('keeps the counts of pruned live history', () => {
    const pruned = replay({
      notes: [note(30, 3)],
      scores: [{ score: 9000, time: 29, immediateMaxPossibleScore: 10000 }],
      combos: [{ combo: 0, time: 30 }],
      liveHistoryBase: { scoringNotes: 90, misses: 2, badCuts: 1, bombCuts: 1, wallsHit: 0, maxCombo: 60 },
    });
    expect(multiviewReplayScore(pruned, 31)).toMatchObject({
      score: 9000,
      accuracy: 0.9,
      maxCombo: 60,
      notesMissed: 3,
      badCuts: 1,
      bombHits: 1,
    });
  });
});
