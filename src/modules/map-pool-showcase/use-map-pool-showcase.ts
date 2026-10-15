import { useEffect, useRef, useState } from 'react';

import type { useSongTransport } from '../viewer/use-song-transport';
import type { useViewerSession } from '../viewer/use-viewer-session';
import type { PreparedBeatLeaderShowcase, useViewerSources } from '../viewer/use-viewer-sources';
import {
  difficultyRank,
  type MapPoolShowcaseConfig,
  type MapPoolShowcaseMap,
} from './map-pool-showcase';

type Sources = ReturnType<typeof useViewerSources>;
type Session = ReturnType<typeof useViewerSession>;
type Transport = ReturnType<typeof useSongTransport>;
type PreparedEntry = { kind: 'ready'; value: PreparedBeatLeaderShowcase } | { kind: 'missing' };
type ActiveEntry = { map: MapPoolShowcaseMap; replayAvailable: boolean };
type TransitionPhase = 'idle' | 'preparing' | 'fading-out' | 'loading' | 'fading-in';

const TRANSITION_DURATION_MS = 1400;
const TRANSITION_DURATION_SECONDS = TRANSITION_DURATION_MS / 1000;

function isMap(value: unknown): value is MapPoolShowcaseMap {
  if (typeof value !== 'object' || value === null) return false;
  const map = value as Record<string, unknown>;
  return (
    typeof map.reference === 'string' &&
    typeof map.key === 'string' &&
    typeof map.hash === 'string' &&
    typeof map.name === 'string' &&
    typeof map.characteristic === 'string' &&
    typeof map.difficulty === 'string'
  );
}

export function parseMapPoolShowcaseConfig(value: unknown): MapPoolShowcaseConfig | null {
  if (typeof value === 'string') {
    try {
      return parseMapPoolShowcaseConfig(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.maps) || config.maps.length === 0 || !config.maps.every(isMap)) return null;
  const durationSeconds = Number(config.durationSeconds);
  return {
    maps: config.maps,
    loop: config.loop !== false,
    startMode: config.startMode === 'start' ? 'start' : 'preview',
    durationMode: config.durationMode === 'full' ? 'full' : 'seconds',
    durationSeconds: Number.isFinite(durationSeconds) ? Math.max(1, durationSeconds) : 30,
  };
}

function mapReference(map: MapPoolShowcaseMap) {
  return map.hash.length >= 10 ? map.hash : map.key || map.reference;
}

function mapIdentity(map: MapPoolShowcaseMap) {
  return `${map.hash.toLowerCase() || map.key.toLowerCase()}:${map.characteristic.toLowerCase()}:${map.difficulty.toLowerCase()}`;
}

export function useMapPoolShowcase({
  enabled,
  configValue,
  session,
  sources,
  transport,
}: {
  enabled: boolean;
  configValue?: string;
  session: Session;
  sources: Sources;
  transport: Transport;
}) {
  const [active, setActive] = useState<ActiveEntry | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<TransitionPhase>('idle');
  const [visualFaded, setVisualFaded] = useState(false);
  const configRef = useRef<MapPoolShowcaseConfig | null>(null);
  const indexRef = useRef(-1);
  const generationRef = useRef(0);
  const transitioningRef = useRef(false);
  const preparedRef = useRef(new Map<string, Promise<PreparedEntry>>());
  const advanceTimerRef = useRef<number | null>(null);
  const lastPublishRef = useRef({ identity: '', at: 0 });

  function publish(song: Record<string, unknown> | null) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'beatkhana:map-pool-showcase-current-song', song }, '*');
  }

  function setPhase(phase: TransitionPhase) {
    transitioningRef.current = phase !== 'idle';
    setTransitionPhase(phase);
  }

  function clearAdvanceTimer() {
    if (advanceTimerRef.current === null) return;
    window.clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = null;
  }

  function ensurePrepared(map: MapPoolShowcaseMap, generation: number) {
    const identity = mapIdentity(map);
    const existing = preparedRef.current.get(identity);
    if (existing !== undefined) return existing;
    const rank = difficultyRank(map.difficulty);
    const promise =
      rank === undefined
        ? Promise.resolve<PreparedEntry>({ kind: 'missing' })
        : sources
            .fetchPreparedBeatLeaderShowcase(mapReference(map), rank, map.characteristic)
            .then((result): PreparedEntry =>
              generation !== generationRef.current || result.isErr()
                ? { kind: 'missing' }
                : { kind: 'ready', value: result.value },
            );
    preparedRef.current.set(identity, promise);
    return promise;
  }

  function maintainWindow(index: number, generation: number) {
    const config = configRef.current;
    const maps = config?.maps ?? [];
    const keep = new Set<string>();
    for (let offset = 0; offset <= 2; offset++) {
      const requestedIndex = index + offset;
      const map =
        requestedIndex < maps.length
          ? maps[requestedIndex]
          : config?.loop && maps.length > 0
            ? maps[requestedIndex % maps.length]
            : undefined;
      if (map === undefined) continue;
      keep.add(mapIdentity(map));
      void ensurePrepared(map, generation);
    }
    for (const identity of preparedRef.current.keys()) {
      if (!keep.has(identity)) preparedRef.current.delete(identity);
    }
  }

  async function activate(index: number, generation: number) {
    if (generation !== generationRef.current || transitioningRef.current) return;
    clearAdvanceTimer();
    const config = configRef.current;
    if (config === null) return;
    let resolvedIndex = index;
    if (resolvedIndex >= config.maps.length) {
      if (!config.loop) {
        setPhase('fading-out');
        setVisualFaded(true);
        await transport.fadeTransitionGain(0, TRANSITION_DURATION_MS);
        if (generation !== generationRef.current) return;
        indexRef.current = -1;
        setActive(null);
        publish(null);
        sources.clearSource();
        setPhase('idle');
        return;
      }
      resolvedIndex = 0;
    }
    const map = config.maps[resolvedIndex];
    if (map === undefined) return;
    setPhase('preparing');
    indexRef.current = resolvedIndex;
    maintainWindow(resolvedIndex, generation);
    const prepared = await ensurePrepared(map, generation);
    if (generation !== generationRef.current) {
      return;
    }
    setPhase('fading-out');
    setVisualFaded(true);
    const fadeDuration = transport.clockRef.current === null ? 0 : TRANSITION_DURATION_MS;
    await transport.fadeTransitionGain(0, fadeDuration);
    if (generation !== generationRef.current) return;
    if (prepared.kind === 'missing') {
      sources.clearSource();
      setVisualFaded(false);
      setPhase('idle');
      setActive({ map, replayAvailable: false });
      publish({ ...map, currentSeconds: 0, progressPercent: 0, replayAvailable: false });
      maintainWindow(resolvedIndex, generation);
      advanceTimerRef.current = window.setTimeout(() => void activate(resolvedIndex + 1, generation), 4000);
      return;
    }
    setPhase('loading');
    const infoPreviewStart = prepared.value.previewStartSeconds;
    const configuredPreviewStart = Number(map.previewStartSeconds);
    const startSeconds =
      config.startMode === 'preview'
        ? infoPreviewStart || (Number.isFinite(configuredPreviewStart) ? Math.max(0, configuredPreviewStart) : 0)
        : 0;
    const loaded = await sources.loadPreparedBeatLeaderShowcase(prepared.value, {
      autoplay: true,
      startSeconds,
      difficultyRank: difficultyRank(map.difficulty),
      characteristic: map.characteristic,
    });
    if (generation !== generationRef.current) return;
    if (loaded.isErr()) {
      setVisualFaded(false);
      setPhase('idle');
      setActive({ map, replayAvailable: false });
      publish({ ...map, currentSeconds: 0, progressPercent: 0, replayAvailable: false });
      advanceTimerRef.current = window.setTimeout(() => void activate(resolvedIndex + 1, generation), 4000);
      return;
    }
    setActive({ map, replayAvailable: true });
    maintainWindow(resolvedIndex, generation);
  }

  useEffect(() => {
    if (!enabled && configRef.current === null) return;
    const generation = ++generationRef.current;
    const config = enabled ? parseMapPoolShowcaseConfig(configValue) : null;
    configRef.current = config;
    preparedRef.current.clear();
    setPhase('idle');
    setVisualFaded(false);
    transport.setTransitionGain(1);
    clearAdvanceTimer();
    setActive(null);
    publish(null);
    if (config === null) {
      sources.clearSource();
      return;
    }
    indexRef.current = -1;
    maintainWindow(0, generation);
    void activate(0, generation);
  }, [configValue, enabled]);

  useEffect(() => {
    if (
      !enabled ||
      transitionPhase !== 'loading' ||
      active === null ||
      !active.replayAvailable ||
      session.selectedKey === ''
    )
      return;
    const generation = generationRef.current;
    setPhase('fading-in');
    setVisualFaded(false);
    void transport.fadeTransitionGain(1, TRANSITION_DURATION_MS).then((completed) => {
      if (completed && generation === generationRef.current) setPhase('idle');
    });
  }, [active, enabled, session.selectedKey, transitionPhase]);

  useEffect(() => {
    if (
      !enabled ||
      transitionPhase !== 'idle' ||
      active === null ||
      !active.replayAvailable ||
      session.selectedKey === ''
    )
      return;
    clearAdvanceTimer();
    const config = configRef.current;
    if (config?.durationMode !== 'seconds') return;
    const requested = config.durationSeconds;
    const remaining = transport.duration > 0 ? Math.max(0.1, transport.duration - transport.time) : requested;
    const delaySeconds = Math.max(0.1, Math.min(requested, remaining) - TRANSITION_DURATION_SECONDS);
    const generation = generationRef.current;
    const index = indexRef.current;
    advanceTimerRef.current = window.setTimeout(() => void activate(index + 1, generation), delaySeconds * 1000);
    return clearAdvanceTimer;
  }, [active, enabled, session.selectedKey, transitionPhase]);

  useEffect(() => {
    if (!enabled || active === null || !active.replayAvailable || transitioningRef.current) return;
    const config = configRef.current;
    const shouldAdvance =
      transport.ended ||
      (config?.durationMode === 'full' &&
        transport.duration > 0 &&
        transport.duration - transport.time <= TRANSITION_DURATION_SECONDS);
    if (shouldAdvance) void activate(indexRef.current + 1, generationRef.current);
  }, [active, enabled, transport.duration, transport.ended, transport.time]);

  useEffect(() => {
    if (!enabled || active === null) return;
    const identity = `${mapIdentity(active.map)}:${indexRef.current}:${active.replayAvailable}`;
    const now = Date.now();
    if (lastPublishRef.current.identity === identity && now - lastPublishRef.current.at < 250) return;
    lastPublishRef.current = { identity, at: now };
    publish({
      ...active.map,
      currentSeconds: active.replayAvailable ? transport.time : 0,
      durationSeconds: transport.duration || active.map.durationSeconds,
      progressPercent:
        active.replayAvailable && transport.duration > 0
          ? Math.min(100, (transport.time / transport.duration) * 100)
          : 0,
      replayAvailable: active.replayAvailable,
      replayPlayer: active.replayAvailable ? sources.replayPlayer : null,
    });
  }, [active, enabled, sources.replayPlayer, transport.duration, transport.time]);

  useEffect(
    () => () => {
      generationRef.current++;
      clearAdvanceTimer();
      transport.setTransitionGain(1);
      publish(null);
    },
    [],
  );

  return { visualFaded };
}
