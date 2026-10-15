import { useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { Result } from 'better-result';

import { replayMapHash, type Replay } from '../../core/replay/types';
import type { ViewerSettings } from '../../core/viewer-settings';
import {
  fetchBeatLeaderLeaderboards,
  fetchBeatLeaderReplayFile,
  fetchBeatLeaderReplayMetadata,
  fetchTopBeatLeaderScore,
} from '../../sources/beatleader/provider';
import { fetchBeatSaverHash, fetchBeatSaverMap } from '../../sources/beatsaver/provider';
import { isViewerSourceEnabled } from '../../sources/source-config';
import { SourceError } from '../../sources/source-error';
import type {
  BeatSaverMapSource,
  DownloadProgress,
  MapLookup,
  ScoreSaberReplayPlayer,
} from '../../sources/source-types';
import { LiveMapCache } from '../live/live-map-cache';
import type { PendingSharedView } from './use-viewer-file-source';
import { useViewerFileSource } from './use-viewer-file-source';
import { useViewerRemoteSource } from './use-viewer-remote-source';

interface UseViewerSourcesOptions {
  remoteSourcesEnabled?: boolean;
  setError: (message: string) => void;
  setSettings: Dispatch<SetStateAction<ViewerSettings>>;
  onClearViewer: () => void;
  onMapLoaded: () => void;
  liveMapCache?: LiveMapCache;
  sharedParser?: import('../../core/beatmap/worker/client').BeatmapParser;
  /** Replay to load instead of the page's replayUrl, e.g. one multiview tile's recording. */
  replayUrl?: string;
}

export interface PreparedBeatLeaderShowcase {
  map: BeatSaverMapSource;
  player: ScoreSaberReplayPlayer;
  previewStartSeconds: number;
  replay: Replay;
  scoreId: string;
}

function normalizedCharacteristic(value: string) {
  return value
    .toLowerCase()
    .replace(/^solo/, '')
    .replace(/[^a-z0-9]/g, '');
}

async function mapPreviewStartSeconds(source: BeatSaverMapSource) {
  const info = source.files.find((file) => file.name.toLowerCase() === 'info.dat');
  if (info === undefined) return 0;
  try {
    const value: unknown = JSON.parse(await info.text());
    if (typeof value !== 'object' || value === null) return 0;
    const root = value as Record<string, unknown>;
    const legacy = Number(root._previewStartTime);
    if (Number.isFinite(legacy)) return Math.max(0, legacy);
    const audio = root.audio;
    if (typeof audio !== 'object' || audio === null) return 0;
    const modern = Number((audio as Record<string, unknown>).previewStartTime);
    return Number.isFinite(modern) ? Math.max(0, modern) : 0;
  } catch {
    return 0;
  }
}

export function useViewerSources({
  remoteSourcesEnabled = true,
  setError,
  setSettings,
  onClearViewer,
  onMapLoaded,
  liveMapCache: sharedLiveMapCache,
  sharedParser,
  replayUrl,
}: UseViewerSourcesOptions) {
  const [sourceChoices, setSourceChoices] = useState<MapLookup[]>([]);
  const [liveDownloadProgress, setLiveDownloadProgress] = useState<DownloadProgress>(null);
  const ownedLiveMapCache = useRef(new LiveMapCache());
  const liveMapCache = sharedLiveMapCache ?? ownedLiveMapCache.current;
  const files = useViewerFileSource({
    setError,
    onClearViewer,
    onMapLoaded,
    onSourceLoaded: () => {
      setSourceChoices([]);
    },
    sharedParser,
  });
  const remote = useViewerRemoteSource({
    beginSourceRequest: files.beginSourceRequest,
    enabled: remoteSourcesEnabled,
    isSourceRequestCurrent: files.isSourceRequestCurrent,
    replayUrl,
    mapIdentity: files.mapIdentity,
    loadSourceFiles: files.loadSourceFiles,
    parseReplay: files.parseReplay,
    pendingSharedViewRef: files.pendingSharedViewRef,
    setError,
    setSettings,
    setSourceChoices,
  });

  return {
    audioDataRef: files.audioDataRef,
    clearSource: files.clearSource,
    coverUrl: files.coverUrl,
    hasLiveMap(hash: string) {
      return liveMapCache.has(hash);
    },
    loadFiles(selectedFiles: File[]) {
      return files.loadFiles(selectedFiles, remote.resolveReplayMap);
    },
    loadLookup: remote.loadLookup,
    async fetchPreparedMap(reference: string, signal?: AbortSignal) {
      const value = reference.trim();
      return value.length >= 10 ? fetchBeatSaverHash(value, { signal }) : fetchBeatSaverMap(value, { signal });
    },
    async loadPreparedMap(source: BeatSaverMapSource, pending: PendingSharedView) {
      const requestId = files.beginSourceRequest();
      files.pendingSharedViewRef.current = pending;
      const loaded = await files.loadSourceFiles(requestId, source.files, null, {
        identity: { key: source.key, hash: source.hash },
      });
      return loaded.isErr() ? Result.err(loaded.error) : Result.ok(undefined);
    },
    async fetchPreparedBeatLeaderShowcase(
      reference: string,
      difficultyRank: number,
      characteristic: string,
      signal?: AbortSignal,
    ) {
      if (!isViewerSourceEnabled('beatleader')) {
        return Result.err(
          new SourceError({
            message: 'BeatLeader is disabled',
            source: 'beatleader',
            operation: 'validate-source-enabled',
          }),
        );
      }
      const mapResult = await (reference.trim().length >= 10
        ? fetchBeatSaverHash(reference.trim(), { signal })
        : fetchBeatSaverMap(reference.trim(), { signal }));
      if (mapResult.isErr()) return Result.err(mapResult.error);
      const map = mapResult.value;
      const [leaderboardsResult, previewStartSeconds] = await Promise.all([
        fetchBeatLeaderLeaderboards(map.hash, { signal }),
        mapPreviewStartSeconds(map),
      ]);
      if (leaderboardsResult.isErr()) return Result.err(leaderboardsResult.error);
      const requestedCharacteristic = normalizedCharacteristic(characteristic);
      const leaderboard = leaderboardsResult.value.find(
        (candidate) =>
          candidate.difficulty === difficultyRank &&
          normalizedCharacteristic(candidate.gameMode) === requestedCharacteristic,
      );
      if (leaderboard === undefined) {
        return Result.err(
          new SourceError({
            message: 'No BeatLeader leaderboard is available for this map difficulty',
            source: 'beatleader',
            operation: 'find-leaderboard',
          }),
        );
      }
      const scoreResult = await fetchTopBeatLeaderScore(leaderboard.id, { signal });
      if (scoreResult.isErr()) return Result.err(scoreResult.error);
      const metadataResult = await fetchBeatLeaderReplayMetadata(scoreResult.value, { signal });
      if (metadataResult.isErr()) return Result.err(metadataResult.error);
      const metadata = metadataResult.value;
      const replayFileResult = await fetchBeatLeaderReplayFile(metadata.replayUrl, { signal });
      if (replayFileResult.isErr()) return Result.err(replayFileResult.error);
      const replayResult = await files.parseReplay(replayFileResult.value, 'beatleader');
      if (replayResult.isErr()) return Result.err(replayResult.error);
      const replayHash = replayMapHash(replayResult.value);
      if (replayHash?.toLowerCase() !== map.hash.toLowerCase()) {
        return Result.err(
          new SourceError({
            message: 'The top BeatLeader replay belongs to a different map',
            source: 'beatleader',
            operation: 'validate-replay-map',
          }),
        );
      }
      return Result.ok<PreparedBeatLeaderShowcase>({
        map,
        player: metadata.player,
        previewStartSeconds,
        replay: replayResult.value,
        scoreId: metadata.scoreId,
      });
    },
    async loadPreparedBeatLeaderShowcase(source: PreparedBeatLeaderShowcase, pending: PendingSharedView) {
      const requestId = files.beginSourceRequest();
      files.pendingSharedViewRef.current = pending;
      const loaded = await files.loadSourceFiles(requestId, source.map.files, source.replay, {
        identity: { key: source.map.key, hash: source.map.hash },
        scoreIdBL: source.scoreId,
        player: source.player,
      });
      return loaded.isErr() ? Result.err(loaded.error) : Result.ok(undefined);
    },
    async loadLiveReplay(hash: string, replay: Replay) {
      const requestId = files.beginSourceRequest();
      files.pendingSharedViewRef.current = {};
      const cached = liveMapCache.get(hash);
      if (cached !== undefined) {
        setLiveDownloadProgress(null);
        const loaded = await files.loadSourceFiles(requestId, cached.files, replay, {
          identity: { key: cached.key, hash: cached.hash },
        });
        return loaded.isErr() ? Result.err(loaded.error) : Result.ok(undefined);
      }
      setLiveDownloadProgress(null);
      const source = await liveMapCache.getOrLoad(hash, () =>
        fetchBeatSaverHash(hash, {
          onProgress(progress) {
            if (files.isSourceRequestCurrent(requestId)) setLiveDownloadProgress(progress);
          },
        }),
      );
      if (!files.isSourceRequestCurrent(requestId)) return Result.ok(undefined);
      if (source.isErr()) return Result.err(source.error);
      const loaded = await files.loadSourceFiles(requestId, source.value.files, replay, {
        identity: { key: source.value.key, hash: source.value.hash },
      });
      if (loaded.isErr()) return Result.err(loaded.error);
      return Result.ok(undefined);
    },
    async loadWatchPartyMapByHash(hash: string, signal?: AbortSignal) {
      const requestId = files.beginSourceRequest();
      files.pendingSharedViewRef.current = null;
      setLiveDownloadProgress(null);
      const source = await fetchBeatSaverHash(hash, {
        onProgress(progress) {
          if (files.isSourceRequestCurrent(requestId)) setLiveDownloadProgress(progress);
        },
        signal,
      });
      if (!files.isSourceRequestCurrent(requestId)) return Result.ok(null);
      if (source.isErr()) return Result.err(source.error);
      const loaded = await files.loadSourceFiles(requestId, source.value.files, null, {
        identity: { key: source.value.key, hash: source.value.hash },
      });
      if (loaded.isErr()) return Result.err(loaded.error);
      if (!files.isSourceRequestCurrent(requestId)) return Result.ok(null);
      liveMapCache.set(source.value);
      return Result.ok({ identity: { key: source.value.key, hash: source.value.hash }, rows: loaded.value });
    },
    async loadWatchPartyMapById(input: string, signal?: AbortSignal) {
      const requestId = files.beginSourceRequest();
      files.pendingSharedViewRef.current = null;
      setLiveDownloadProgress(null);
      const source = await fetchBeatSaverMap(input, {
        onProgress(progress) {
          if (files.isSourceRequestCurrent(requestId)) setLiveDownloadProgress(progress);
        },
        signal,
      });
      if (!files.isSourceRequestCurrent(requestId)) return Result.ok(null);
      if (source.isErr()) return Result.err(source.error);
      const loaded = await files.loadSourceFiles(requestId, source.value.files, null, {
        identity: { key: source.value.key, hash: source.value.hash },
      });
      if (loaded.isErr()) return Result.err(loaded.error);
      if (!files.isSourceRequestCurrent(requestId)) return Result.ok(null);
      liveMapCache.set(source.value);
      return Result.ok({ identity: { key: source.value.key, hash: source.value.hash }, rows: loaded.value });
    },
    loadSource: remote.loadSource,
    liveDownloadProgress,
    mapIdentity: files.mapIdentity,
    mapMeta: files.mapMeta,
    pendingSharedViewRef: files.pendingSharedViewRef,
    replayPlayer: files.replayPlayer,
    replayRef: files.replayRef,
    rows: files.rows,
    scoreSaberLeaderboards: remote.scoreSaberLeaderboards,
    beatLeaderLeaderboards: remote.beatLeaderLeaderboards,
    shareScoreId: files.shareScoreId,
    shareScoreIdBL: files.shareScoreIdBL,
    songBpm: files.songBpm,
    sourceLink: files.sourceLink,
    sourceChoices,
    sourceInput: remote.sourceInput,
    sourceDownload: remote.sourceDownload,
    sourceLoading: remote.sourceLoading,
    setSourceInput: remote.setSourceInput,
  };
}
