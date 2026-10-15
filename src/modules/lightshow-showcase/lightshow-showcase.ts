export interface LightshowShowcaseMap {
  reference: string;
  key: string;
  hash: string;
  name: string;
  artist: string;
  mapper: string;
  coverUrl: string;
  durationSeconds: number;
  bpm: number;
  characteristic: string;
  difficulty: string;
  difficultyLabel?: string;
  njs?: number;
  nps?: number;
}

export interface LightshowShowcaseConfig {
  maps: LightshowShowcaseMap[];
  loop: boolean;
  playbackMode: 'order' | 'random';
  lastMap: LightshowShowcaseMap | null;
  targetAtMs: number | null;
}

export interface PlannedLightshowMap {
  map: LightshowShowcaseMap;
  startSeconds: number;
}

export interface LightshowPlan {
  entries: PlannedLightshowMap[];
  startAtMs: number;
}

export interface TimedLightshowPosition {
  index: number;
  startSeconds: number;
}

function duration(map: LightshowShowcaseMap) {
  return Math.max(0, map.durationSeconds || 0);
}

export function shuffled<T>(values: readonly T[], random: () => number = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    const current = result[index];
    const replacement = result[target];
    if (current === undefined || replacement === undefined) continue;
    result[index] = replacement;
    result[target] = current;
  }
  return result;
}

export function orderedCycle(config: Pick<LightshowShowcaseConfig, 'maps' | 'playbackMode'>, random = Math.random) {
  return config.playbackMode === 'random' ? shuffled(config.maps, random) : [...config.maps];
}

/** Resolves wall-clock time to the map and song position that should be visible. */
export function resolveTimedLightshow(
  entries: readonly PlannedLightshowMap[],
  timelineStartAtMs: number,
  nowMs = Date.now(),
): TimedLightshowPosition | null {
  let entryStartAtMs = timelineStartAtMs;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const playableSeconds = Math.max(0, duration(entry.map) - entry.startSeconds);
    const entryEndAtMs = entryStartAtMs + playableSeconds * 1000;
    if (nowMs < entryEndAtMs) {
      const elapsedSeconds = Math.max(0, (nowMs - entryStartAtMs) / 1000);
      return {
        index,
        startSeconds: Math.min(duration(entry.map), entry.startSeconds + elapsedSeconds),
      };
    }
    entryStartAtMs = entryEndAtMs;
  }
  return null;
}

export function planLightshow(
  config: LightshowShowcaseConfig,
  nowMs = Date.now(),
  random: () => number = Math.random,
): LightshowPlan {
  const targetAtMs = config.targetAtMs === null ? null : Math.max(nowMs, config.targetAtMs);
  const availableSeconds = targetAtMs === null ? null : Math.max(0, (targetAtMs - nowMs) / 1000);
  const last = config.lastMap && duration(config.lastMap) > 0 ? config.lastMap : null;
  const lastIdentity = last === null ? '' : last.hash.toLowerCase() || last.key.toLowerCase();
  const base = config.maps.filter(
    (map) =>
      duration(map) > 0 && (lastIdentity === '' || (map.hash.toLowerCase() || map.key.toLowerCase()) !== lastIdentity),
  );

  if (availableSeconds === null) {
    const entries = orderedCycle({ maps: base, playbackMode: config.playbackMode }, random).map((map) => ({
      map,
      startSeconds: 0,
    }));
    if (last !== null) entries.push({ map: last, startSeconds: 0 });
    return { entries, startAtMs: nowMs };
  }
  const target = targetAtMs ?? nowMs;

  const tail: LightshowShowcaseMap[] = last === null ? [] : [last];
  let total = last === null ? 0 : duration(last);
  let guard = 0;
  while (total < availableSeconds && base.length > 0 && guard++ < 10_000) {
    const cycle = orderedCycle({ maps: base, playbackMode: config.playbackMode }, random);
    for (let index = cycle.length - 1; index >= 0 && total < availableSeconds; index--) {
      const map = cycle[index];
      if (map === undefined) continue;
      tail.unshift(map);
      total += duration(map);
    }
    if (!config.loop) break;
  }

  if (tail.length === 0) return { entries: [], startAtMs: target };
  const overflow = Math.max(0, total - availableSeconds);
  if (overflow > 0 && tail[0] !== undefined) {
    const firstDuration = duration(tail[0]);
    if (overflow >= firstDuration) {
      // A last map longer than the remaining countdown starts part-way through.
      const finalMap = tail.at(-1);
      if (finalMap !== undefined) {
        return { entries: [{ map: finalMap, startSeconds: Math.min(overflow, duration(finalMap)) }], startAtMs: nowMs };
      }
    }
  }
  return {
    entries: tail.map((map, index) => ({ map, startSeconds: index === 0 ? overflow : 0 })),
    startAtMs: total < availableSeconds ? target - total * 1000 : nowMs,
  };
}
