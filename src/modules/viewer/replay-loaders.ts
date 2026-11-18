// Pure replay loaders: fetch + parse + validate one replay and return it. They own
// no viewer state, so the single-replay viewer and /br can share them.
import { Result } from 'better-result';

import type { BeatmapParser } from '../../core/beatmap/worker/client';
import { isBeatLeaderReplay } from '../../core/replay/parse-beatleader';
import { applyLegacyScoreSaberMetadata, isScoreSaberReplay } from '../../core/replay/parse-scoresaber';
import { replayMapHash, type Replay } from '../../core/replay/types';
import { fetchBeatLeaderReplayFile, fetchBeatLeaderReplayMetadata } from '../../sources/beatleader/provider';
import { fetchBeatSaverHash } from '../../sources/beatsaver/provider';
import { requestArrayBuffer } from '../../sources/http';
import { fetchScoreSaberReplayFile, fetchScoreSaberReplayMetadata } from '../../sources/scoresaber/provider';
import { isViewerSourceEnabled } from '../../sources/source-config';
import { SourceError, sourceError } from '../../sources/source-error';
import type {
  BeatSaverMapSource,
  DownloadProgress,
  ScoreSaberReplayPlayer,
  SourceResult,
} from '../../sources/source-types';
import { isTaReplayFile, parseTaReplayFile } from '../live/ta-replay-file';

export type ParseReplay = (data: ArrayBuffer, source?: SourceError['source']) => Promise<SourceResult<Replay>>;

export type ReplayDownloadKind = 'beatleader' | 'beatsaver' | 'replay' | 'scoresaber';

// Translated error strings, so these functions stay free of i18n hooks
export interface ReplayLoadMessages {
  beatleaderReplayMapMismatch: string;
  replayDifficultyMismatch: string;
  replayMapMismatch: string;
  replayMissingHash: string;
  sourceDisabled: string;
}

export interface ReplayLoadOptions<WithMap extends boolean = false> {
  messages: ReplayLoadMessages;
  parseReplay: ParseReplay;
  /** Also download the BeatSaver map of the replay, in parallel with the replay itself. */
  withMap?: WithMap;
  signal?: AbortSignal;
  /** Return false once the result is no longer wanted; the loader then resolves to null. */
  isCurrent?: () => boolean;
  onDownload?: (kind: ReplayDownloadKind, progress: DownloadProgress) => void;
}

export type LoadedReplay<WithMap extends boolean = false> = {
  replay: Replay;
  /** Uppercase SHA-1 of the map, read from the replay. */
  mapHash: string;
  player?: ScoreSaberReplayPlayer;
  scoreId?: string;
} & (WithMap extends true ? { map: BeatSaverMapSource } : { map?: undefined });

// null: the request went stale (isCurrent returned false) before it finished
type LoadResult<WithMap extends boolean> = SourceResult<LoadedReplay<WithMap> | null>;

const legacyDifficultyRanks = new Map(
  Object.entries({
    easy: 1,
    normal: 3,
    hard: 5,
    expert: 7,
    expertplus: 9,
  }),
);

export function legacyMetadataFromFilename(name: string) {
  const match = /-([^-]+)-([^-]+)-([0-9a-f]{40})\.dat$/i.exec(name);
  if (match === null) return null;
  const difficulty = legacyDifficultyRanks.get(match[1]?.toLowerCase() ?? '');
  const characteristic = match[2];
  const hash = match[3];
  return difficulty === undefined || characteristic === undefined || hash === undefined
    ? null
    : { difficulty, characteristic, hash };
}

export function sourceDownloadUrl(value: string) {
  return new URL(value).protocol === 'https:' ? `/api/source?${new URLSearchParams({ url: value }).toString()}` : value;
}

function disabledSource(source: 'beatleader' | 'beatsaver' | 'scoresaber', message: string) {
  return Result.err(new SourceError({ message, source, operation: 'validate-source-enabled' }));
}

function downloader(options: Pick<ReplayLoadOptions, 'onDownload' | 'signal'>) {
  return (kind: ReplayDownloadKind) => {
    options.onDownload?.(kind, null);
    return {
      signal: options.signal,
      onProgress: (progress: DownloadProgress) => {
        options.onDownload?.(kind, progress);
      },
    };
  };
}

export async function parseReplayBytes(
  data: ArrayBuffer,
  source: SourceError['source'],
  getParser: () => BeatmapParser,
  sourceDisabledMessage: string,
) {
  const bytes = new Uint8Array(data);
  if (
    (isBeatLeaderReplay(bytes) && !isViewerSourceEnabled('beatleader')) ||
    (isScoreSaberReplay(bytes) && !isViewerSourceEnabled('scoresaber'))
  ) {
    return Result.err(
      new SourceError({
        message: sourceDisabledMessage,
        source,
        operation: 'validate-replay-source',
      }),
    );
  }
  // Recorded TournamentAssistant streams are decoded here rather than in the
  // parser worker, which only knows the BeatLeader and ScoreSaber formats.
  if (isTaReplayFile(bytes)) {
    return Result.try({
      try: () => parseTaReplayFile(bytes),
      catch: (cause) =>
        sourceError(cause, {
          message: cause instanceof Error ? cause.message : 'replay could not be parsed',
          source,
          operation: 'parse-replay',
        }),
    });
  }
  const parser = getParser();
  return Result.tryPromise({
    try: () => parser.parseReplay(data),
    catch: (cause) =>
      sourceError(cause, {
        message: cause instanceof Error ? cause.message : 'replay could not be parsed',
        source,
        operation: 'parse-replay',
      }),
  });
}

export async function loadScoreSaberReplay<WithMap extends boolean = false>(
  scoreId: string,
  options: ReplayLoadOptions<WithMap>,
): Promise<LoadResult<WithMap>> {
  if (!isViewerSourceEnabled('scoresaber')) return disabledSource('scoresaber', options.messages.sourceDisabled);
  const download = downloader(options);
  const isCurrent = () => options.isCurrent?.() ?? true;
  return Result.gen(async function* () {
    const metadataPromise = fetchScoreSaberReplayMetadata(scoreId, download('scoresaber'));
    const initialReplayPromise = fetchScoreSaberReplayFile(scoreId, download('scoresaber'));
    const source = yield* Result.await(metadataPromise);
    if (!isCurrent()) return Result.ok(null);
    const replayFilePromise =
      source.scoreId === scoreId
        ? initialReplayPromise
        : fetchScoreSaberReplayFile(source.scoreId, download('scoresaber'));
    const [replayResult, mapResult] = await Promise.all([
      replayFilePromise.then((result) =>
        result.isErr() ? Result.err(result.error) : options.parseReplay(result.value, 'scoresaber'),
      ),
      options.withMap === true ? fetchBeatSaverHash(source.hash, download('beatsaver')) : Promise.resolve(undefined),
    ]);
    if (!isCurrent()) return Result.ok(null);
    const replay = yield* replayResult;
    const map = mapResult === undefined ? undefined : yield* mapResult;
    if (!isCurrent()) return Result.ok(null);
    applyLegacyScoreSaberMetadata(replay, source);
    const replayHash = replayMapHash(replay);
    if (replayHash?.toLowerCase() !== source.hash.toLowerCase()) {
      return Result.err(
        new SourceError({
          message: options.messages.replayMapMismatch,
          source: 'scoresaber',
          operation: 'validate-replay-map',
        }),
      );
    }
    if (
      replay.metadata.difficulty !== source.difficulty ||
      replay.metadata.characteristic.toLowerCase() !== source.characteristic.toLowerCase()
    ) {
      return Result.err(
        new SourceError({
          message: options.messages.replayDifficultyMismatch,
          source: 'scoresaber',
          operation: 'validate-replay-difficulty',
        }),
      );
    }
    return Result.ok({
      replay,
      mapHash: replayHash,
      player: source.player,
      scoreId: source.scoreId,
      map,
    } as LoadedReplay<WithMap>);
  });
}

export async function loadBeatLeaderReplay<WithMap extends boolean = false>(
  scoreId: string,
  options: ReplayLoadOptions<WithMap>,
): Promise<LoadResult<WithMap>> {
  if (!isViewerSourceEnabled('beatleader')) return disabledSource('beatleader', options.messages.sourceDisabled);
  const download = downloader(options);
  const isCurrent = () => options.isCurrent?.() ?? true;
  return Result.gen(async function* () {
    const metadataPromise = fetchBeatLeaderReplayMetadata(scoreId, download('beatleader'));
    const source = yield* Result.await(metadataPromise);
    if (!isCurrent()) return Result.ok(null);
    const replayFilePromise = fetchBeatLeaderReplayFile(source.replayUrl, download('beatleader'));
    const [replayResult, mapResult] = await Promise.all([
      replayFilePromise.then((result) =>
        result.isErr() ? Result.err(result.error) : options.parseReplay(result.value, 'beatleader'),
      ),
      options.withMap === true ? fetchBeatSaverHash(source.hash, download('beatsaver')) : Promise.resolve(undefined),
    ]);
    if (!isCurrent()) return Result.ok(null);
    const replay = yield* replayResult;
    const map = mapResult === undefined ? undefined : yield* mapResult;
    if (!isCurrent()) return Result.ok(null);

    const replayHash = replayMapHash(replay);
    if (replayHash?.toLowerCase() !== source.hash.toLowerCase()) {
      return Result.err(
        new SourceError({
          message: options.messages.beatleaderReplayMapMismatch,
          source: 'beatleader',
          operation: 'validate-replay-map',
        }),
      );
    }
    return Result.ok({
      replay,
      mapHash: replayHash,
      player: source.player,
      scoreId: source.scoreId,
      map,
    } as LoadedReplay<WithMap>);
  });
}

// Parse replay bytes (downloaded or read from a file) and read the map hash. The map
// is only downloaded when asked for, after parsing, since the hash comes from the replay.
export async function loadReplayData<WithMap extends boolean = false>(
  data: ArrayBuffer,
  options: ReplayLoadOptions<WithMap>,
  filename?: string,
): Promise<LoadResult<WithMap>> {
  const download = downloader(options);
  const isCurrent = () => options.isCurrent?.() ?? true;
  return Result.gen(async function* () {
    const replay = yield* Result.await(options.parseReplay(data));
    if (!isCurrent()) return Result.ok(null);
    const legacyMetadata = filename === undefined ? null : legacyMetadataFromFilename(filename);
    if (legacyMetadata !== null) applyLegacyScoreSaberMetadata(replay, legacyMetadata);
    const hash = replayMapHash(replay);
    if (hash === null) {
      return Result.err(
        new SourceError({
          message: options.messages.replayMissingHash,
          source: 'local',
          operation: 'validate-replay-map',
        }),
      );
    }
    const map =
      options.withMap === true ? yield* Result.await(fetchBeatSaverHash(hash, download('beatsaver'))) : undefined;
    if (!isCurrent()) return Result.ok(null);
    return Result.ok({ replay, mapHash: hash, map } as LoadedReplay<WithMap>);
  });
}

export async function loadReplayUrl<WithMap extends boolean = false>(
  replayUrl: string,
  options: ReplayLoadOptions<WithMap>,
): Promise<LoadResult<WithMap>> {
  const download = downloader(options);
  const data = await requestArrayBuffer(sourceDownloadUrl(replayUrl), {
    source: 'local',
    label: 'Replay',
    operation: 'download-replay',
    ...download('replay'),
  });
  if (data.isErr()) return Result.err(data.error);
  if (!(options.isCurrent?.() ?? true)) return Result.ok(null);
  return loadReplayData(data.value, options);
}

export async function loadReplayFile<WithMap extends boolean = false>(
  file: File,
  options: ReplayLoadOptions<WithMap>,
): Promise<LoadResult<WithMap>> {
  const data = await Result.tryPromise({
    try: () => file.arrayBuffer(),
    catch: (cause) =>
      sourceError(cause, {
        message: `${file.name} could not be read`,
        source: 'local',
        operation: 'read-local-file',
      }),
  });
  if (data.isErr()) return Result.err(data.error);
  if (!(options.isCurrent?.() ?? true)) return Result.ok(null);
  return loadReplayData(data.value, options, file.name);
}
