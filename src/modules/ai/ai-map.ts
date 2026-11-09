// Converts the viewer's parsed difficulty into what the AI consumes.
//
// Model notes follow pTrainer/replay_ai/features.load_map: color notes, chain
// tails as "any direction" notes, bombs as color 2 / direction 9, sorted by
// time, lane, layer. Sim notes follow pTrainer/sim/map_parser.py: color notes
// and bombs only, with the v3 angle offset and the game's same-colour pair turn.
// Times come from the viewer's songBpmTime, which already includes BPM changes.

import { songBpmTimeToSeconds } from '../../core/beatmap/bpm';
import { NoteType, type Difficulty } from '../../core/beatmap/types';
import type { SimNote } from './ai-cut-sim';
import type { AiNote, AiWall } from './ai-features';

export interface AiMapData {
  hash: string;
  difficulty: string;
  characteristic: string;
  notes: AiNote[];
  walls: AiWall[];
  simNotes: SimNote[];
  njs: number;
  /** seconds; sim/note_motion.calculate_half_jump_duration_beats */
  halfJumpDuration: number;
}

export const AI_DIFFICULTY_RANKS: Record<string, number> = {
  Easy: 1,
  Normal: 3,
  Hard: 5,
  Expert: 7,
  ExpertPlus: 9,
};

export function aiMapData(
  difficultyData: Difficulty,
  songBpm: number,
  identity: { hash: string; difficulty: string; characteristic: string; njs: number; noteStartBeatOffset: number },
): AiMapData {
  const seconds = (songBpmTime: number) => songBpmTimeToSeconds(songBpmTime, songBpm);
  const colorNotes: AiNote[] = [];
  const bombs: AiNote[] = [];
  const simNotes: SimNote[] = [];
  for (const note of difficultyData.notes) {
    if (note.customFake) continue;
    const time = seconds(note.songBpmTime);
    if (note.type === NoteType.Red || note.type === NoteType.Blue) {
      colorNotes.push([time, note.posX, note.posY, note.type, note.cutDirection]);
      simNotes.push({
        noteId: note.posX * 1000 + note.posY * 100 + note.type * 10 + note.cutDirection,
        time,
        angleOffset: note.angleOffset,
      });
    } else if (note.type === NoteType.Bomb) {
      bombs.push([time, note.posX, note.posY, 2, 9]);
      simNotes.push({ noteId: note.posX * 1000 + note.posY * 100 + 30, time });
    }
  }
  const chains: AiNote[] = difficultyData.chains
    .filter((chain) => !chain.customFake)
    .map((chain) => [seconds(chain.tailSongBpmTime), chain.tailPosX, chain.tailPosY, chain.color, 8]);
  const notes = [...colorNotes, ...chains, ...bombs].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const walls: AiWall[] = difficultyData.obstacles
    .filter((wall) => !wall.customFake)
    .map((wall) => {
      const start = seconds(wall.songBpmTime);
      const end = seconds(wall.songBpmTime + wall.durationSongBpmTime);
      return [start, end - start, wall.posX, wall.posY, wall.width, wall.height];
    });

  return {
    hash: identity.hash,
    difficulty: identity.difficulty,
    characteristic: identity.characteristic,
    notes,
    walls,
    simNotes: snapSameColourPairs(simNotes.sort((a, b) => a.time - b.time)),
    njs: identity.njs,
    halfJumpDuration: halfJumpDurationSeconds(songBpm, identity.njs, identity.noteStartBeatOffset),
  };
}

/** sim/note_motion.calculate_half_jump_duration_beats, in seconds. */
function halfJumpDurationSeconds(bpm: number, njs: number, startBeatOffset: number) {
  let halfJump = 4;
  const secondsPerBeat = 60 / bpm;
  while (njs * secondsPerBeat * halfJump > 18) halfJump /= 2;
  return Math.max(halfJump + startBeatOffset, 0.25) * secondsPerBeat;
}

const DIR_2D: Record<number, [number, number]> = {
  0: [0, 1],
  1: [0, -1],
  2: [-1, 0],
  3: [1, 0],
  4: [-0.7071, 0.7071],
  5: [0.7071, 0.7071],
  6: [-0.7071, -0.7071],
  7: [0.7071, -0.7071],
};
const LINE_Y = [0.25, 0.85, 1.45]; // StaticBeatmapObjectSpawnMovementData.LineYPosForLineLayer

/** Vector2.SignedAngle (degrees, counter-clockwise positive, sign(0) = +). */
function signedAngle2d(a: [number, number], b: [number, number]) {
  const lengths = Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]);
  if (lengths < 1e-15) return 0;
  const angle = (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / lengths))) * 180) / Math.PI;
  return a[0] * b[1] - a[1] * b[0] >= 0 ? angle : -angle;
}

/**
 * map_parser._snap_same_colour_pairs (BeatmapObjectsInTimeRowProcessor): when exactly two notes
 * of one colour share a beat (within 1 ms of the first), the game turns them to line up with each
 * other (replacing any v3 angle offset), unless that takes more than 40 deg. Notes sorted by time.
 */
function snapSameColourPairs(notes: SimNote[]) {
  for (const colour of [0, 1]) {
    const slices: SimNote[][] = [];
    let start: number | null = null;
    for (const note of notes) {
      if (Math.floor((note.noteId % 10000) / 10) % 10 !== colour) continue;
      const last = slices[slices.length - 1];
      if (start === null || last === undefined || note.time > start + 0.001) {
        start = note.time;
        slices.push([note]);
      } else last.push(note);
    }
    for (const pair of slices) {
      const [a, b] = pair;
      if (pair.length !== 2 || a === undefined || b === undefined) continue;
      const d1 = a.noteId % 10;
      const d2 = b.noteId % 10;
      if (d1 !== d2 && d1 !== 8 && d2 !== 8) continue;
      const [first, second] = d1 !== 8 ? [a, b] : [b, a];
      const dirFirst = first.noteId % 10;
      const pos = (note: SimNote): [number, number] => {
        const base = note.noteId % 10000;
        return [((Math.floor(base / 1000) % 10) - 1.5) * 0.6, LINE_Y[Math.min(2, Math.floor(base / 100) % 10)] ?? 0];
      };
      const p1 = pos(first);
      const p2 = pos(second);
      const line: [number, number] = [p2[0] - p1[0], p2[1] - p1[1]];
      const vec = DIR_2D[dirFirst] ?? [0, 1];
      const s1 = signedAngle2d(vec, line);
      const s2 = signedAngle2d(vec, [-line[0], -line[1]]);
      const angle = Math.abs(s1) < Math.abs(s2) ? s1 : s2;
      if (dirFirst === 8 && second.noteId % 10 === 8) {
        first.angleOffset = angle;
        second.angleOffset = angle;
        continue;
      }
      if (Math.abs(angle) > 40) continue;
      first.angleOffset = angle;
      second.angleOffset = second.noteId % 10 === 8 && dirFirst > 3 ? angle + 45 : angle;
    }
  }
  return notes;
}
