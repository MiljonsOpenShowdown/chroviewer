import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import { BeatmapParser } from '../../core/beatmap/worker/client';
import { MultiviewRendererHost } from '../../renderer/multiview-renderer-host';
import { broadcastSettingsForPlayerCount } from '../../renderer/render-performance';
import { fetchBeatSaverHash } from '../../sources/beatsaver/provider';
import { EmbeddedRealtimeScoreTimeline } from '../live/embedded-realtime-score-sync';
import { LiveMapCache } from '../live/live-map-cache';
import type { MultiviewPlaybackSnapshot, MultiviewTileProps } from '../viewer/viewer-embed-types';
import type {
  MultiviewConfigMessage,
  MultiviewControlMessage,
  MultiviewPerfMessage,
  MultiviewPlayerConfig,
  MultiviewReplayScore,
  MultiviewStateMessage,
} from './multiview-protocol';
import { MultiviewStartBarrier } from './multiview-start-barrier';
import {
  advanceMultiviewCorrection,
  MultiviewTimeline,
  multiviewAudioOwner,
  multiviewSyncTime,
  type MultiviewCorrectionState,
} from './multiview-timeline';

interface NativeCompositorBridge {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
}

declare global {
  interface Window {
    beatKhanaNativeCompositor?: NativeCompositorBridge;
  }
}

/** Soonest a changed replay score is sent after the last state message. */
const SCORE_PUBLISH_MIN_MS = 50;

/** The tiles' replay scores without their song time, which moves on every tick. */
function scoresSignature(scores: (MultiviewReplayScore | null)[]) {
  return JSON.stringify(scores.map((score) => (score === null ? null : { ...score, songPosition: 0 })));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validReplayUrl(value: unknown) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 4096 || !URL.canParse(value)) return false;
  return new URL(value).protocol === 'https:';
}

function validControl(value: Record<string, unknown>): value is Record<string, unknown> & MultiviewControlMessage {
  if (value.version !== 1) return false;
  if (value.action === 'play' || value.action === 'pause') return true;
  if (value.action === 'sync') return typeof value.anchorId === 'string';
  return value.action === 'seek' && typeof value.time === 'number' && Number.isFinite(value.time) && value.time >= 0;
}

function validPlayer(value: unknown): value is MultiviewPlayerConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.playerId === 'string' &&
    /^\d+$/.test(value.playerId) &&
    Array.isArray(value.platformIds) &&
    validReplayUrl(value.replayUrl) &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
    typeof value.visible === 'boolean' &&
    typeof value.masterVolume === 'number' &&
    typeof value.hitsoundVolume === 'number' &&
    typeof value.disableGameUI === 'boolean' &&
    (value.hidePlatform === undefined || typeof value.hidePlatform === 'boolean') &&
    (value.lights === 'full' || value.lights === 'static' || value.lights === 'none') &&
    (value.backgroundColor === undefined || typeof value.backgroundColor === 'string') &&
    (value.waitingColor === undefined || typeof value.waitingColor === 'string') &&
    (value.waitingText === undefined || typeof value.waitingText === 'string') &&
    isRecord(value.settings)
  );
}

function configurationSignature(players: MultiviewPlayerConfig[]) {
  return JSON.stringify(players.map(({ score: _score, ...configuration }) => configuration));
}

interface TilePlaybackState {
  duration: number;
  error: string;
  hasMap: boolean;
  playing: boolean;
  status: MultiviewPlaybackSnapshot['status'];
}

function waitingLabel(player: MultiviewPlayerConfig, playback: TilePlaybackState | undefined) {
  // A recorded replay is shown as soon as it is loaded, including while paused.
  if (player.replayUrl !== undefined) {
    if (playback?.status === 'error') return playback.error || 'Replay unavailable';
    return playback?.status === 'watching' ? null : 'Loading replay';
  }
  if (
    playback !== undefined &&
    playback.status === 'watching' &&
    playback.playing &&
    playback.hasMap &&
    playback.duration > 0
  )
    return null;
  switch (playback?.status) {
    case 'connecting':
      return 'Connecting to TournamentAssistant';
    case 'reconnecting':
      return 'Reconnecting to TournamentAssistant';
    case 'loading':
      return 'Downloading replay map';
    case 'buffering':
      return 'Preparing replay stream';
    case 'paused':
      return 'Player paused';
    case 'error':
      return playback.error || 'Replay stream unavailable';
    default:
      return player.waitingText || 'Waiting for replay stream';
  }
}

/** Player fields a route fills in when a config message leaves them out. */
export type MultiviewPlayerDefaults = Partial<Omit<MultiviewPlayerConfig, 'settings'>> & {
  settings?: MultiviewPlayerConfig['settings'];
};

function withDefaults(value: unknown, defaults: MultiviewPlayerDefaults | undefined) {
  if (defaults === undefined || !isRecord(value)) return value;
  return {
    ...defaults,
    ...value,
    settings: { ...defaults.settings, ...(isRecord(value.settings) ? value.settings : {}) },
  };
}

interface MultiviewShellProps {
  /** Renders each tile; the full viewer or the lighter overlay shell. */
  Tile: ComponentType<MultiviewTileProps>;
  playerDefaults?: MultiviewPlayerDefaults;
}

export function MultiviewShell({ Tile, playerDefaults }: MultiviewShellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [host, setHost] = useState<MultiviewRendererHost | null>(null);
  const [parser, setParser] = useState<BeatmapParser | null>(null);
  const [players, setPlayers] = useState<MultiviewPlayerConfig[]>([]);
  const playersRef = useRef(players);
  playersRef.current = players;
  const configSignatureRef = useRef('');
  const [tilePlayback, setTilePlayback] = useState<Map<string, TilePlaybackState>>(() => new Map());
  const mapCache = useMemo(() => new LiveMapCache(), []);
  const timeline = useMemo(() => new MultiviewTimeline(), []);
  const startBarrier = useMemo(() => new MultiviewStartBarrier(), []);
  useEffect(() => () => startBarrier.dispose(), [startBarrier]);
  const parentOriginRef = useRef<string | null>(null);
  const playbackRef = useRef(new Map<string, MultiviewPlaybackSnapshot>());
  const correctionStateRef = useRef(new Map<string, MultiviewCorrectionState>());
  const correctingRef = useRef(new Set<string>());
  const nextSyncCheckRef = useRef(new Map<string, number>());
  const scoreTimelinesRef = useRef(new Map<string, EmbeddedRealtimeScoreTimeline>());
  const playerIdentitiesRef = useRef(new Map<string, string>());
  const lastStatePublishRef = useRef(Number.NEGATIVE_INFINITY);
  const nativeBridge = typeof window === 'undefined' ? undefined : window.beatKhanaNativeCompositor;

  useEffect(() => {
    const sharedParser = new BeatmapParser();
    setParser(sharedParser);
    return () => sharedParser.dispose();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rendererHost = new MultiviewRendererHost(canvas);
    setHost(rendererHost);
    return () => {
      setHost(null);
      rendererHost.dispose();
    };
  }, []);

  useEffect(() => {
    function applyConfig(data: unknown) {
      if (!isRecord(data) || data.type !== 'beatkhana:multiview-config' || data.version !== 1) return;
      const raw: unknown = (data as unknown as MultiviewConfigMessage).players;
      if (!Array.isArray(raw)) return;
      const next = raw.map((player: unknown) => withDefaults(player, playerDefaults));
      if (next.length > 12 || !next.every(validPlayer) || new Set(next.map((player) => player.id)).size !== next.length)
        return;
      for (const player of next) {
        let scoreTimeline = scoreTimelinesRef.current.get(player.id);
        // A tile switching player or recording starts from a clean sync state.
        const identity = `${player.playerId}|${player.replayUrl ?? ''}`;
        if (playerIdentitiesRef.current.get(player.id) !== identity) {
          scoreTimeline?.clear();
          playerIdentitiesRef.current.set(player.id, identity);
          correctionStateRef.current.delete(player.id);
          correctingRef.current.delete(player.id);
          nextSyncCheckRef.current.delete(player.id);
        }
        if (scoreTimeline === undefined) {
          scoreTimeline = new EmbeddedRealtimeScoreTimeline();
          scoreTimelinesRef.current.set(player.id, scoreTimeline);
        }
        if (isRecord(player.score)) scoreTimeline.add(player.score);
      }
      // Maps the parent expects to be played download now, not once a stream starts
      const preload = (data as Partial<MultiviewConfigMessage>).preloadMapHashes;
      if (Array.isArray(preload)) {
        for (const hash of preload.slice(0, 4)) {
          if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) continue;
          const key = hash.toUpperCase();
          if (!mapCache.has(key)) void mapCache.getOrLoad(key, () => fetchBeatSaverHash(key));
        }
      }
      // Scores update continuously. Keep them in the timeline without turning
      // every packet into a React rerender of every POV.
      const signature = configurationSignature(next);
      if (signature !== configSignatureRef.current) {
        configSignatureRef.current = signature;
        startBarrier.configure(next);
        setPlayers(next);
      }
    }
    // Every other live tile on the anchor's map that shows gameplay goes to the
    // anchor's time, or the nearest one it has data for. The anchor (the tile
    // the audio follows) never moves.
    function syncLiveTiles(anchorId: string) {
      const now = performance.now();
      const anchorPlayback = playbackRef.current.get(anchorId);
      const anchor = timeline.ownSample(anchorId, now);
      if (anchor === null || anchorPlayback?.status !== 'watching') return;
      for (const player of playersRef.current) {
        const playback = playbackRef.current.get(player.id);
        if (
          player.id === anchorId ||
          player.replayUrl !== undefined ||
          !player.visible ||
          playback?.status !== 'watching' ||
          playback.mapHash !== anchorPlayback.mapHash
        )
          continue;
        const range = playback.seekableRange();
        const own = timeline.ownSample(player.id, now);
        if (range === null || own === null) continue;
        correctionStateRef.current.delete(player.id);
        correctingRef.current.delete(player.id);
        nextSyncCheckRef.current.delete(player.id);
        const time = multiviewSyncTime(anchor.time, range);
        if (Math.abs(own.time - time) > 0.02) playback.seek(time);
      }
    }
    function applyControl(data: MultiviewControlMessage) {
      if (data.action === 'sync') {
        syncLiveTiles(data.anchorId ?? '');
        return;
      }
      const now = performance.now();
      const replayIds = playersRef.current
        .filter((player) => player.replayUrl !== undefined)
        .map((player) => player.id);
      const tiles = replayIds.flatMap((id) => {
        const playback = playbackRef.current.get(id);
        return playback === undefined ? [] : [{ id, playback }];
      });
      // Every replay tile is moved to one shared time, so play and pause also
      // remove any drift that built up instead of waiting for a correction.
      const time = data.action === 'seek' ? (data.time ?? 0) : timeline.primary(now)?.time;
      for (const { id, playback } of tiles) {
        correctionStateRef.current.delete(id);
        correctingRef.current.delete(id);
        nextSyncCheckRef.current.delete(id);
        if (data.action === 'pause') playback.pause();
        if (time !== undefined) playback.seek(time);
        if (data.action === 'play') playback.play();
      }
    }
    function handleMessage(data: unknown) {
      if (!isRecord(data)) return;
      if (data.type === 'beatkhana:multiview-control') {
        if (validControl(data)) applyControl(data);
        return;
      }
      applyConfig(data);
    }
    if (nativeBridge !== undefined) {
      const removeListener = nativeBridge.onMessage(handleMessage);
      nativeBridge.send({ type: 'beatkhana:multiview-ready', version: 1 });
      return removeListener;
    }
    function receive(event: MessageEvent) {
      // Any page may embed the viewer, so only the sender frame is checked.
      if (event.source !== window.parent) return;
      parentOriginRef.current = event.origin;
      handleMessage(event.data);
    }
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'beatkhana:multiview-ready', version: 1 }, '*');
    return () => window.removeEventListener('message', receive);
  }, [mapCache, nativeBridge, playerDefaults, startBarrier, timeline]);

  useEffect(() => {
    if (host === null) return;
    const activeIds = new Set(players.map((player) => player.id));
    const visiblePlayers = players.filter((player) => player.visible);
    timeline.configure(visiblePlayers);
    for (const player of players) {
      host.setTile(player.id, {
        x: player.x,
        y: player.y,
        width: player.width,
        height: player.height,
        visible: player.visible,
      });
    }
    host.retainTiles(activeIds);
    for (const id of playbackRef.current.keys()) {
      if (!activeIds.has(id)) playbackRef.current.delete(id);
    }
    for (const id of correctionStateRef.current.keys()) {
      if (!activeIds.has(id)) correctionStateRef.current.delete(id);
    }
    for (const id of correctingRef.current) {
      if (!activeIds.has(id)) correctingRef.current.delete(id);
    }
    for (const id of nextSyncCheckRef.current.keys()) {
      if (!activeIds.has(id)) nextSyncCheckRef.current.delete(id);
    }
    setTilePlayback((current) => {
      if ([...current.keys()].every((id) => activeIds.has(id))) return current;
      return new Map([...current].filter(([id]) => activeIds.has(id)));
    });
    for (const id of scoreTimelinesRef.current.keys()) {
      if (!activeIds.has(id)) {
        scoreTimelinesRef.current.delete(id);
        playerIdentitiesRef.current.delete(id);
      }
    }
  }, [host, players, timeline]);

  useEffect(() => {
    // Each tile's score from its own replay at the time it shows, as last sent
    let publishedScores = '';
    const replayScores = (now: number) =>
      players.map(
        (player) => playbackRef.current.get(player.id)?.scoreAt(timeline.sampleFor(player.id, now)?.time ?? 0) ?? null,
      );
    const publishState = (now: number, scores: (MultiviewReplayScore | null)[]) => {
      const primarySample = timeline.primary(now);
      if (primarySample === null) return;
      const primary = playbackRef.current.get(primarySample.id);
      if (primary === undefined || primary.duration <= 0) return;
      lastStatePublishRef.current = now;
      publishedScores = scoresSignature(scores);
      const message: MultiviewStateMessage = {
        type: 'beatkhana:multiview-state',
        version: 1,
        time: primarySample.time,
        beat: primarySample.beat,
        duration: primarySample.duration,
        playing: primarySample.playing,
        mapHash: primarySample.mapHash,
        map: primary.map,
        players: players.map((player, index) => ({
          id: player.id,
          playerId: player.playerId,
          platformIds: player.platformIds,
          score:
            scoreTimelinesRef.current.get(player.id)?.at(timeline.sampleFor(player.id, now)?.time ?? 0)?.score ??
            player.score,
          replayScore: scores[index] ?? null,
          status: playbackRef.current.get(player.id)?.status ?? 'waiting',
          streamId: playbackRef.current.get(player.id)?.streamId ?? null,
          time: timeline.sampleFor(player.id, now)?.time ?? 0,
        })),
      };
      if (nativeBridge !== undefined) nativeBridge.send(message);
      else {
        const origin = parentOriginRef.current;
        // Sandboxed parents report an opaque "null" origin, which postMessage cannot target.
        if (origin !== null) window.parent.postMessage(message, origin === 'null' ? '*' : origin);
      }
    };
    // A note cut changes a tile's replay score: sent at once, not on the next
    // 5 Hz publish, so the parent's HUD changes with the cut on screen
    const scoreTimer = window.setInterval(() => {
      const now = performance.now();
      if (now - lastStatePublishRef.current < SCORE_PUBLISH_MIN_MS) return;
      const scores = replayScores(now);
      if (scoresSignature(scores) !== publishedScores) publishState(now, scores);
    }, SCORE_PUBLISH_MIN_MS);
    const timer = window.setInterval(() => {
      const snapshots = players
        .map((player) => ({ player, playback: playbackRef.current.get(player.id) }))
        .filter(
          (entry): entry is { player: MultiviewPlayerConfig; playback: MultiviewPlaybackSnapshot } =>
            entry.playback !== undefined && entry.playback.duration > 0,
        );
      const now = performance.now();
      const primarySample = timeline.primary(now);
      if (primarySample === null) return;
      const primary = snapshots.find((entry) => entry.player.id === primarySample.id);
      if (primary === undefined) return;
      for (const entry of snapshots) {
        if (entry.player.id === primary.player.id) {
          correctionStateRef.current.delete(entry.player.id);
          nextSyncCheckRef.current.delete(entry.player.id);
          if (correctingRef.current.delete(entry.player.id)) entry.playback.correctDrift(primarySample.time);
          continue;
        }
        const sameMap =
          entry.playback.mapHash !== null && primary.playback.mapHash !== null
            ? entry.playback.mapHash === primary.playback.mapHash
            : entry.playback.map?.title === primary.playback.map?.title;
        const ownSample = timeline.ownSample(entry.player.id, now);
        const syncReady = entry.playback.status === 'watching' && entry.playback.playing;
        const aheadBy = ownSample === null ? 0 : ownSample.time - primarySample.time;
        if (!sameMap || !syncReady) {
          correctionStateRef.current.delete(entry.player.id);
          nextSyncCheckRef.current.delete(entry.player.id);
          if (correctingRef.current.delete(entry.player.id) && ownSample !== null) {
            entry.playback.correctDrift(ownSample.time);
          }
          continue;
        }
        if (
          !correctingRef.current.has(entry.player.id) &&
          now >= (nextSyncCheckRef.current.get(entry.player.id) ?? 0)
        ) {
          const threshold = Number(entry.player.settings.syncThresholdMs ?? 200);
          const interval = Number(entry.player.settings.syncIntervalMs ?? 2000);
          nextSyncCheckRef.current.set(
            entry.player.id,
            now + (Number.isFinite(interval) ? Math.max(100, interval) : 2000),
          );
          const correction = advanceMultiviewCorrection(
            correctionStateRef.current.get(entry.player.id),
            aheadBy,
            now,
            Number.isFinite(threshold) ? Math.max(0.025, threshold / 1000) : 0.2,
          );
          correctionStateRef.current.set(entry.player.id, correction.state);
          if (correction.correct) correctingRef.current.add(entry.player.id);
        }
        if (correctingRef.current.has(entry.player.id)) {
          entry.playback.correctDrift(primarySample.time);
          if (Math.abs(aheadBy) <= 0.01) correctingRef.current.delete(entry.player.id);
        }
      }
      // Parent overlay state drives a large Svelte scene tree. Five updates per
      // second are enough for score/progress consumers while keeping that work
      // away from the WebGL frame loop. Active corrections advance at 10 Hz;
      // drift detection uses each player's configured observation interval.
      if (now - lastStatePublishRef.current < 200) return;
      publishState(now, replayScores(now));
    }, 100);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(scoreTimer);
    };
  }, [nativeBridge, players, timeline]);

  // Once a second, how the shared renderer keeps up, for the parent's profiling.
  // Not sent to the native compositor, which has no use for it.
  useEffect(() => {
    if (host === null || nativeBridge !== undefined) return;
    const timer = window.setInterval(() => {
      const origin = parentOriginRef.current;
      if (origin === null) return;
      const message: MultiviewPerfMessage = { type: 'beatkhana:multiview-perf', version: 1, ...host.takeStats() };
      window.parent.postMessage(message, origin === 'null' ? '*' : origin);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [host, nativeBridge]);

  const handlePlayback = useCallback(
    (id: string, snapshot: MultiviewPlaybackSnapshot) => {
      playbackRef.current.set(id, snapshot);
      timeline.update(id, {
        beat: snapshot.beat,
        bpm: snapshot.bpm,
        duration: snapshot.duration,
        mapHash: snapshot.mapHash,
        mapTitle: snapshot.map?.title ?? null,
        playbackRate: snapshot.playbackRate,
        playing: snapshot.playing,
        syncReady: snapshot.status === 'watching',
        time: snapshot.time,
      });
      const next: TilePlaybackState = {
        duration: snapshot.duration,
        error: snapshot.error,
        hasMap: snapshot.map !== null,
        playing: snapshot.playing,
        status: snapshot.status,
      };
      setTilePlayback((current) => {
        const previous = current.get(id);
        if (
          previous !== undefined &&
          previous.duration === next.duration &&
          previous.error === next.error &&
          previous.hasMap === next.hasMap &&
          previous.playing === next.playing &&
          previous.status === next.status
        )
          return current;
        const updated = new Map(current);
        updated.set(id, next);
        return updated;
      });
    },
    [timeline],
  );

  const runtimePlayers = useMemo(() => {
    const visible = players.filter((player) => player.visible);
    const audioOwner = multiviewAudioOwner(visible);
    const defaults = broadcastSettingsForPlayerCount(visible.length);
    return visible.map((player) => ({
      ...player,
      settings: {
        // qualityPreset "" opts a tile out of the broadcast performance
        // defaults; it keeps only the multiview sync timing
        ...(player.settings.qualityPreset === ''
          ? { syncThresholdMs: defaults.syncThresholdMs, syncIntervalMs: defaults.syncIntervalMs }
          : defaults),
        ...player.settings,
      },
      masterVolume: player.id === audioOwner ? player.masterVolume : 0,
    }));
  }, [players]);

  return (
    <main data-multiview-root className="relative size-full overflow-hidden bg-transparent">
      {runtimePlayers.map((player) => {
        const label = waitingLabel(player, tilePlayback.get(player.id));
        return label === null ? null : (
          <div
            key={`${player.id}:waiting`}
            className="pointer-events-none absolute z-20 grid place-items-center overflow-hidden px-4 text-center font-bold uppercase"
            style={{
              background: player.backgroundColor || '#000000',
              color: player.waitingColor || 'rgba(255,255,255,.72)',
              height: `${Math.max(1, player.height)}px`,
              left: `${player.x}px`,
              top: `${player.y}px`,
              width: `${Math.max(1, player.width)}px`,
            }}
          >
            <span className="flex items-center gap-3 text-[clamp(12px,1.25vw,24px)] leading-tight">
              <i className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent" />
              {label}
            </span>
          </div>
        );
      })}
      <canvas ref={canvasRef} className="absolute inset-0 z-10 size-full" />
      {host !== null &&
        parser !== null &&
        runtimePlayers.map((player) => (
          <Tile
            // A new recording remounts the tile so its sources load from scratch.
            key={`${player.id}:${player.replayUrl ?? ''}`}
            multiview={{
              id: player.id,
              playerId: player.playerId,
              replayUrl: player.replayUrl,
              host,
              mapCache,
              masterVolume: player.masterVolume,
              hitsoundVolume: player.hitsoundVolume,
              disableGameUI: player.disableGameUI,
              hidePlatform: player.hidePlatform ?? false,
              lights: player.lights,
              timeline,
              startBarrier,
              settings: player.settings,
              parser,
              onPlayback: (snapshot) => handlePlayback(player.id, snapshot),
            }}
          />
        ))}
    </main>
  );
}
