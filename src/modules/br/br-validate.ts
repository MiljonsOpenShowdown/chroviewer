import type { Replay } from '../../core/replay/types';

interface BrValidationPlayer {
  label: string;
  replay: Replay;
  /** Uppercase SHA-1 of the map, from the replay. */
  mapHash: string;
}

export interface BrMismatch {
  /** The replay that differs from the first one. */
  label: string;
  referenceLabel: string;
  field: 'map' | 'difficulty' | 'characteristic';
  expected: string;
  actual: string;
}

// All replays must share one note track. The first player is the reference; the first
// replay that differs in map, difficulty or characteristic is reported.
export function findBrMismatch(players: BrValidationPlayer[]): BrMismatch | null {
  const reference = players[0];
  if (reference === undefined) return null;
  for (const player of players.slice(1)) {
    const mismatch = (field: BrMismatch['field'], expected: string, actual: string): BrMismatch => ({
      label: player.label,
      referenceLabel: reference.label,
      field,
      expected,
      actual,
    });
    if (player.mapHash.toLowerCase() !== reference.mapHash.toLowerCase()) {
      return mismatch('map', reference.mapHash, player.mapHash);
    }
    if (player.replay.metadata.difficulty !== reference.replay.metadata.difficulty) {
      return mismatch(
        'difficulty',
        String(reference.replay.metadata.difficulty),
        String(player.replay.metadata.difficulty),
      );
    }
    if (
      player.replay.metadata.characteristic.toLowerCase() !== reference.replay.metadata.characteristic.toLowerCase()
    ) {
      return mismatch(
        'characteristic',
        reference.replay.metadata.characteristic,
        player.replay.metadata.characteristic,
      );
    }
  }
  return null;
}
