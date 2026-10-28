import { replayScoreStateAt } from '../../core/replay/scoring';
import type { Replay } from '../../core/replay/types';
import type { MultiviewReplayScore } from './multiview-protocol';

/** A replay's score at a song time, for MultiviewStateMessage's replayScore. */
export function multiviewReplayScore(replay: Replay | null, time: number): MultiviewReplayScore | null {
  const first = replay?.scores[0];
  if (replay === null || first === undefined || first.time > time) return null;
  const state = replayScoreStateAt(replay, time);
  return {
    score: state.score,
    accuracy: state.accuracy,
    combo: state.combo,
    maxCombo: state.maxCombo,
    notesMissed: state.misses,
    badCuts: state.badCuts,
    bombHits: state.bombCuts,
    songPosition: time,
  };
}
