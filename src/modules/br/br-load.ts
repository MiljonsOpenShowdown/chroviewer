import { Result } from 'better-result';

import type { Replay } from '../../core/replay/types';
import { fetchBeatSaverHash, fetchBeatSaverMap } from '../../sources/beatsaver/provider';
import { SourceError } from '../../sources/source-error';
import type { BeatSaverMapSource, ScoreSaberReplayPlayer, SourceResult } from '../../sources/source-types';
import {
  loadBeatLeaderReplay,
  loadReplayFile,
  loadReplayUrl,
  loadScoreSaberReplay,
  type ParseReplay,
  type ReplayLoadMessages,
} from '../viewer/replay-loaders';
import { brEntryLabel, type BrEntry } from './br-search';
import { findBrMismatch, type BrMismatch } from './br-validate';

export interface BrPlayer {
  entry: BrEntry;
  label: string;
  name: string;
  replay: Replay;
  /** Uppercase SHA-1 of the map, from the replay. */
  mapHash: string;
  /** Set for ScoreSaber and BeatLeader entries. */
  profile?: ScoreSaberReplayPlayer;
}

export interface BrSession {
  /** In entry order. */
  players: BrPlayer[];
  mapHash: string;
  map: BeatSaverMapSource;
}

export interface BrLoadMessages extends ReplayLoadMessages {
  tooFewPlayers: string;
  mapOverrideMismatch: string;
  mismatch: (mismatch: BrMismatch) => string;
}

interface BrLoadOptions {
  messages: BrLoadMessages;
  parseReplay: ParseReplay;
  /** BeatSaver key or map hash the replays are expected to be on. */
  map?: string;
  signal?: AbortSignal;
  onPlayerLoaded?: (loaded: number, total: number) => void;
}

function namedError(label: string, error: SourceError) {
  return new SourceError({
    message: `${label}: ${error.message}`,
    source: error.source,
    operation: error.operation,
    status: error.status,
    cause: error,
  });
}

// Loads every replay, checks they share one map, difficulty and characteristic, and
// downloads the shared map once.
export async function loadBrSession(
  entries: BrEntry[],
  { messages, parseReplay, map: mapReference, signal, onPlayerLoaded }: BrLoadOptions,
): Promise<SourceResult<BrSession>> {
  if (entries.length < 2) {
    return Result.err(
      new SourceError({ message: messages.tooFewPlayers, source: 'local', operation: 'validate-br-players' }),
    );
  }
  const replayOptions = { messages, parseReplay, signal };
  let loadedCount = 0;
  const results = await Promise.all(
    entries.map(async (entry): Promise<SourceResult<BrPlayer>> => {
      const label = brEntryLabel(entry);
      const loaded =
        entry.kind === 'scoresaber'
          ? await loadScoreSaberReplay(entry.id, replayOptions)
          : entry.kind === 'beatleader'
            ? await loadBeatLeaderReplay(entry.id, replayOptions)
            : entry.kind === 'url'
              ? await loadReplayUrl(entry.url, replayOptions)
              : await loadReplayFile(entry.file, replayOptions);
      if (loaded.isErr()) return Result.err(namedError(label, loaded.error));
      // Without an isCurrent callback a loader never resolves to null
      if (loaded.value === null) {
        return Result.err(new SourceError({ message: label, source: 'local', operation: 'load-br-replay' }));
      }
      loadedCount++;
      onPlayerLoaded?.(loadedCount, entries.length);
      const { replay, mapHash, player } = loaded.value;
      return Result.ok({
        entry,
        label,
        name: player?.name ?? replay.metadata.player?.name ?? label,
        replay,
        profile: player,
        mapHash,
      });
    }),
  );
  const players: BrPlayer[] = [];
  for (const result of results) {
    if (result.isErr()) return Result.err(result.error);
    players.push(result.value);
  }

  const mismatch = findBrMismatch(players);
  if (mismatch !== null) {
    return Result.err(
      new SourceError({
        message: messages.mismatch(mismatch),
        source: 'local',
        operation: 'validate-br-replays',
      }),
    );
  }

  const mapHash = players[0]?.mapHash;
  if (mapHash === undefined) {
    return Result.err(
      new SourceError({ message: messages.tooFewPlayers, source: 'local', operation: 'validate-br-players' }),
    );
  }
  const map = await (mapReference === undefined
    ? fetchBeatSaverHash(mapHash, { signal })
    : mapReference.length >= 10
      ? fetchBeatSaverHash(mapReference, { signal })
      : fetchBeatSaverMap(mapReference, { signal }));
  if (map.isErr()) return Result.err(map.error);
  if (map.value.hash.toLowerCase() !== mapHash.toLowerCase()) {
    return Result.err(
      new SourceError({ message: messages.mapOverrideMismatch, source: 'beatsaver', operation: 'validate-br-map' }),
    );
  }
  return Result.ok({
    players,
    mapHash,
    map: map.value,
  });
}
