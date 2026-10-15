import { useEffect, useRef, useState } from 'react';

import type { BeatSaverMapSource } from '../../sources/source-types';
import type { useSongTransport } from '../viewer/use-song-transport';
import type { useViewerSession } from '../viewer/use-viewer-session';
import type { useViewerSources } from '../viewer/use-viewer-sources';
import {
  orderedCycle,
  planLightshow,
  resolveTimedLightshow,
  type LightshowShowcaseConfig,
  type LightshowShowcaseMap,
  type PlannedLightshowMap,
} from './lightshow-showcase';

type Sources = ReturnType<typeof useViewerSources>;
type Session = ReturnType<typeof useViewerSession>;
type Transport = ReturnType<typeof useSongTransport>;

function isMap(value: unknown): value is LightshowShowcaseMap {
  if (typeof value !== 'object' || value === null) return false;
  const map = value as Record<string, unknown>;
  return (
    typeof map.reference === 'string' &&
    typeof map.key === 'string' &&
    typeof map.hash === 'string' &&
    typeof map.name === 'string' &&
    typeof map.characteristic === 'string' &&
    typeof map.difficulty === 'string' &&
    Number.isFinite(Number(map.durationSeconds))
  );
}

function recoverMapsFromTruncatedConfig(value: string): unknown[] | null {
  const mapsKey = /"maps"\s*:/.exec(value);
  if (mapsKey === null) return null;
  const start = value.indexOf('[', mapsKey.index + mapsKey[0].length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth++;
    else if (character === ']' && --depth === 0) {
      try {
        const maps: unknown = JSON.parse(value.slice(start, index + 1));
        return Array.isArray(maps) ? maps : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseLightshowShowcaseConfig(value: unknown): LightshowShowcaseConfig | null {
  if (typeof value === 'string') {
    try {
      return parseLightshowShowcaseConfig(JSON.parse(value));
    } catch {
      const maps = recoverMapsFromTruncatedConfig(value);
      return maps === null ? null : parseLightshowShowcaseConfig({ maps });
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.maps) || !config.maps.every(isMap)) return null;
  return {
    maps: config.maps,
    loop: config.loop !== false,
    playbackMode: config.playbackMode === 'order' ? 'order' : 'random',
    lastMap:
      config.lastMap === null || config.lastMap === undefined ? null : isMap(config.lastMap) ? config.lastMap : null,
    targetAtMs:
      config.targetAtMs === null || !Number.isFinite(Number(config.targetAtMs)) ? null : Number(config.targetAtMs),
  };
}

function mapReference(map: LightshowShowcaseMap) {
  return map.hash.length >= 10 ? map.hash : map.key || map.reference;
}

function difficultyRank(value: string) {
  return ({ easy: 1, normal: 3, hard: 5, expert: 7, expertplus: 9 } as Record<string, number>)[
    value.toLowerCase().replace(/[^a-z]/g, '')
  ];
}

export function useLightshowShowcase({
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
  const [active, setActive] = useState<PlannedLightshowMap | null>(null);
  const configRef = useRef<LightshowShowcaseConfig | null>(null);
  const entriesRef = useRef<PlannedLightshowMap[]>([]);
  const activeIndexRef = useRef(-1);
  const generationRef = useRef(0);
  const transitioningRef = useRef(false);
  const preparedRef = useRef(new Map<string, Promise<BeatSaverMapSource | null>>());
  const timerRef = useRef<number | null>(null);
  const timelineStartAtRef = useRef(0);
  const lastPublishRef = useRef({ identity: '', at: 0 });
  const failedEntriesRef = useRef(new Set<string>());

  function publish(song: Record<string, unknown> | null) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'beatkhana:lightshow-current-song', song }, '*');
  }

  function ensurePrepared(entry: PlannedLightshowMap, generation: number) {
    const identity = entry.map.hash.toLowerCase() || entry.map.key.toLowerCase();
    const existing = preparedRef.current.get(identity);
    if (existing !== undefined) return existing;
    const promise = sources.fetchPreparedMap(mapReference(entry.map)).then((result) => {
      if (generation !== generationRef.current || result.isErr()) return null;
      return result.value;
    });
    preparedRef.current.set(identity, promise);
    return promise;
  }

  function maintainWindow(index: number, generation: number, prefetchNext: boolean) {
    const keep = new Set<string>();
    const ahead = prefetchNext ? 1 : 0;
    for (let offset = 0; offset <= ahead; offset++) {
      const entry = entriesRef.current[index + offset];
      if (entry === undefined) continue;
      const identity = entry.map.hash.toLowerCase() || entry.map.key.toLowerCase();
      keep.add(identity);
      void ensurePrepared(entry, generation);
    }
    for (const identity of preparedRef.current.keys()) {
      if (!keep.has(identity)) preparedRef.current.delete(identity);
    }
  }

  async function activate(index: number, generation: number) {
    if (generation !== generationRef.current || transitioningRef.current) return;
    const timedMode = configRef.current?.targetAtMs != null;
    const timed = timedMode ? resolveTimedLightshow(entriesRef.current, timelineStartAtRef.current) : null;
    if (timedMode && timed === null) {
      setActive(null);
      publish(null);
      sources.clearSource();
      return;
    }
    const resolvedIndex = timed === null ? index : Math.max(index, timed.index);
    const entry = entriesRef.current[resolvedIndex];
    if (entry === undefined) {
      const config = configRef.current;
      // A failed map must not turn a looping showcase into an immediate,
      // unbounded retry cycle. This is especially costly in browser sources,
      // where every retry downloads and extracts the archive again.
      if (failedEntriesRef.current.size > 0) {
        setActive(null);
        publish(null);
        sources.clearSource();
        return;
      }
      if (config?.loop && config.lastMap === null && config.maps.length > 0 && config.targetAtMs === null) {
        entriesRef.current = orderedCycle(config).map((map) => ({ map, startSeconds: 0 }));
        activeIndexRef.current = -1;
        await activate(0, generation);
        return;
      }
      setActive(null);
      publish(null);
      sources.clearSource();
      return;
    }
    transitioningRef.current = true;
    activeIndexRef.current = resolvedIndex;
    // Prepare only the active map during startup. Large lightshow archives can
    // otherwise compete with two speculative downloads and leave OBS browser
    // sources looking permanently blank while all three are extracted.
    maintainWindow(resolvedIndex, generation, false);
    const source = await ensurePrepared(entry, generation);
    if (generation !== generationRef.current) {
      transitioningRef.current = false;
      return;
    }
    if (source === null) {
      failedEntriesRef.current.add(entry.map.hash.toLowerCase() || entry.map.key.toLowerCase());
      transitioningRef.current = false;
      await activate(resolvedIndex + 1, generation);
      return;
    }
    const timedBeforeLoad = timedMode ? resolveTimedLightshow(entriesRef.current, timelineStartAtRef.current) : null;
    if (timedMode && timedBeforeLoad === null) {
      transitioningRef.current = false;
      setActive(null);
      publish(null);
      sources.clearSource();
      return;
    }
    const beforeLoad =
      timedBeforeLoad === null || timedBeforeLoad.index < resolvedIndex
        ? { index: resolvedIndex, startSeconds: entry.startSeconds }
        : timedBeforeLoad;
    if (beforeLoad.index !== resolvedIndex) {
      transitioningRef.current = false;
      await activate(beforeLoad.index, generation);
      return;
    }
    const result = await sources.loadPreparedMap(source, {
      autoplay: true,
      startSeconds: beforeLoad.startSeconds,
      difficultyRank: difficultyRank(entry.map.difficulty),
      characteristic: entry.map.characteristic,
    });
    transitioningRef.current = false;
    if (generation !== generationRef.current || result.isErr()) {
      if (generation === generationRef.current) {
        failedEntriesRef.current.add(entry.map.hash.toLowerCase() || entry.map.key.toLowerCase());
        await activate(resolvedIndex + 1, generation);
      }
      return;
    }
    failedEntriesRef.current.clear();
    const timedAfterLoad = timedMode ? resolveTimedLightshow(entriesRef.current, timelineStartAtRef.current) : null;
    if (timedMode && timedAfterLoad === null) {
      setActive(null);
      publish(null);
      sources.clearSource();
      return;
    }
    const afterLoad = timedAfterLoad === null || timedAfterLoad.index < resolvedIndex ? beforeLoad : timedAfterLoad;
    if (afterLoad.index !== resolvedIndex) {
      await activate(afterLoad.index, generation);
      return;
    }
    if (Math.abs(transport.time - afterLoad.startSeconds) > 0.25) transport.seek(afterLoad.startSeconds);
    setActive({ ...entry, startSeconds: afterLoad.startSeconds });
    // Once the current map is visible, prepare just the next transition. The
    // two-entry window keeps playback smooth without retaining three complete
    // extracted maps in memory.
    maintainWindow(resolvedIndex, generation, true);
  }

  useEffect(() => {
    if (!enabled) return;
    const config = parseLightshowShowcaseConfig(configValue);
    const generation = ++generationRef.current;
    configRef.current = config;
    preparedRef.current.clear();
    failedEntriesRef.current.clear();
    transitioningRef.current = false;
    setActive(null);
    publish(null);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (config === null) {
      entriesRef.current = [];
      sources.clearSource();
      return;
    }
    const plan = planLightshow(config);
    entriesRef.current = plan.entries;
    timelineStartAtRef.current = plan.startAtMs;
    activeIndexRef.current = -1;
    maintainWindow(0, generation, false);
    const delay = Math.max(0, plan.startAtMs - Date.now());
    timerRef.current = window.setTimeout(() => void activate(0, generation), delay);
  }, [configValue, enabled]);

  useEffect(() => {
    if (!enabled || !transport.ended || active === null || transitioningRef.current) return;
    void activate(activeIndexRef.current + 1, generationRef.current);
  }, [active, enabled, transport.ended]);

  useEffect(() => {
    if (!enabled || active === null || configRef.current?.targetAtMs === null || transitioningRef.current) return;
    const expected = resolveTimedLightshow(entriesRef.current, timelineStartAtRef.current);
    if (expected === null) {
      setActive(null);
      publish(null);
      sources.clearSource();
      return;
    }
    if (expected.index > activeIndexRef.current) {
      void activate(expected.index, generationRef.current);
      return;
    }
    if (expected.index < activeIndexRef.current) return;
    // Keep the wall-clock countdown authoritative if loading or playback drifted.
    if (Math.abs(transport.time - expected.startSeconds) > 1) transport.seek(expected.startSeconds);
  }, [active, enabled, transport.time]);

  useEffect(() => {
    if (!enabled || active === null || session.selectedKey === '') return;
    const identity = `${active.map.hash}:${activeIndexRef.current}`;
    const now = Date.now();
    if (lastPublishRef.current.identity === identity && now - lastPublishRef.current.at < 250) return;
    lastPublishRef.current = { identity, at: now };
    publish({
      ...active.map,
      currentSeconds: transport.time,
      durationSeconds: transport.duration || active.map.durationSeconds,
      progressPercent: transport.duration > 0 ? Math.min(100, (transport.time / transport.duration) * 100) : 0,
    });
  }, [active, enabled, session.selectedKey, transport.duration, transport.time]);

  useEffect(
    () => () => {
      generationRef.current++;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      publish(null);
    },
    [],
  );

  return { active };
}
