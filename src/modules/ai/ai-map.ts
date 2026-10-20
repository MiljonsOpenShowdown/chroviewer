// Converts the viewer's parsed difficulty into what the AI consumes.
//
// Model notes follow pTrainer/replay_ai/features.load_map: color notes, chain
// tails as "any direction" notes, bombs as color 2 / direction 9, sorted by
// time, lane, layer. Sim notes follow pTrainer/sim/map_parser.py: color notes
// and bombs only. Times come from the viewer's songBpmTime, which already
// includes BPM changes.

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
  identity: { hash: string; difficulty: string; characteristic: string; njs: number },
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
      simNotes.push({ noteId: note.posX * 1000 + note.posY * 100 + note.type * 10 + note.cutDirection, time });
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
    simNotes: simNotes.sort((a, b) => a.time - b.time),
    njs: identity.njs,
  };
}
