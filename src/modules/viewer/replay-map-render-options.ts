import { effectiveNoteJumpSpeed, type InfoDifficulty } from '../../core/beatmap/info';
import type { MapRenderOptions } from '../../core/placement/map-render-data';
import type { Replay } from '../../core/replay/types';

/** Map render options for one difficulty, with the play settings and notes of `replay` when there is one. */
export function replayMapRenderOptions(
  infoDifficulty: InfoDifficulty,
  legacyNoodleV2Semantics: boolean | undefined,
  songBpm: number,
  replay: Replay | null,
): MapRenderOptions {
  return {
    noteJumpSpeed: effectiveNoteJumpSpeed(infoDifficulty),
    noteStartBeatOffset: infoDifficulty.noteStartBeatOffset,
    songBpm,
    legacyNoodleV2Semantics,
    recordedJumpDistance: replay?.metadata.hasPlaySettings === true ? replay.metadata.jumpDistance : undefined,
    leftHanded: replay?.metadata.leftHanded,
    replayNotes: replay?.notes,
    initialPlayerHeight: replay?.metadata.initialHeight,
    replayHeights: replay?.heights,
    environmentRemoval: infoDifficulty.environmentRemoval,
    modifiers: replay?.metadata.modifiers,
  };
}
