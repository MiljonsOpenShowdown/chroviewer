export interface MultiviewTimelinePlayer {
  id: string;
  masterVolume: number;
}

export interface MultiviewTimelineSnapshot {
  beat: number;
  bpm: number;
  duration: number;
  mapHash: string | null;
  mapTitle: string | null;
  playbackRate: number;
  playing: boolean;
  syncReady: boolean;
  time: number;
}

interface TimedSnapshot {
  observedAt: number;
  snapshot: MultiviewTimelineSnapshot;
}

interface TimelineEntry {
  id: string;
  entry: TimedSnapshot;
}

export interface MultiviewCorrectionState {
  aheadSince: number | null;
  armed: boolean;
}

export const multiviewSyncThresholdSeconds = 0.5;
const multiviewSyncRearmSeconds = 0.2;
const multiviewSyncSustainMs = 1000;

export function advanceMultiviewCorrection(
  current: MultiviewCorrectionState | undefined,
  aheadBy: number,
  now: number,
  thresholdSeconds = multiviewSyncThresholdSeconds,
) {
  const state = current ?? { aheadSince: null, armed: true };
  if (aheadBy <= thresholdSeconds) {
    state.aheadSince = null;
    if (aheadBy <= Math.min(multiviewSyncRearmSeconds, thresholdSeconds / 2)) state.armed = true;
    return { correct: false, state };
  }
  if (!state.armed) return { correct: false, state };
  state.aheadSince ??= now;
  if (now - state.aheadSince < multiviewSyncSustainMs) return { correct: false, state };
  state.aheadSince = null;
  state.armed = false;
  return { correct: true, state };
}

export interface MultiviewTimelineSample extends MultiviewTimelineSnapshot {
  id: string;
}

function sameMap(left: MultiviewTimelineSnapshot, right: MultiviewTimelineSnapshot) {
  if (left.mapHash !== null && right.mapHash !== null) return left.mapHash === right.mapHash;
  return left.mapTitle !== null && left.mapTitle === right.mapTitle;
}

function sampleAt(entry: TimedSnapshot, now: number) {
  const snapshot = entry.snapshot;
  const elapsed = snapshot.playing ? (Math.max(0, now - entry.observedAt) / 1000) * snapshot.playbackRate : 0;
  const time = Math.min(snapshot.duration, Math.max(0, snapshot.time + elapsed));
  return {
    ...snapshot,
    beat: snapshot.beat + ((time - snapshot.time) * snapshot.bpm) / 60,
    time,
  };
}

export function multiviewAudioOwner(players: MultiviewTimelinePlayer[]) {
  let owner: MultiviewTimelinePlayer | undefined;
  for (const player of players) {
    if (player.masterVolume <= 0) continue;
    if (owner === undefined || player.masterVolume > owner.masterVolume) owner = player;
  }
  return owner?.id ?? null;
}

export class MultiviewTimeline {
  private readonly snapshots = new Map<string, TimedSnapshot>();
  private playerOrder: string[] = [];
  private preferredId: string | null = null;
  private anchorId: string | null = null;

  configure(players: MultiviewTimelinePlayer[]) {
    this.playerOrder = players.map((player) => player.id);
    this.preferredId = multiviewAudioOwner(players);
    const active = new Set(this.playerOrder);
    if (this.anchorId !== null && !active.has(this.anchorId)) this.anchorId = null;
    for (const id of this.snapshots.keys()) {
      if (!active.has(id)) this.snapshots.delete(id);
    }
  }

  update(id: string, snapshot: MultiviewTimelineSnapshot, observedAt = performance.now()) {
    this.snapshots.set(id, { observedAt, snapshot: { ...snapshot } });
  }

  private primaryEntry(now: number): TimelineEntry | null {
    let first: TimelineEntry | null = null;
    let firstPlaying: TimelineEntry | null = null;
    let preferred: TimelineEntry | null = null;
    for (const id of this.playerOrder) {
      const entry = this.snapshots.get(id);
      if (entry === undefined || entry.snapshot.duration <= 0) continue;
      const candidate = { id, entry };
      first ??= candidate;
      if (entry.snapshot.playing) firstPlaying ??= candidate;
      if (id !== this.preferredId) continue;
      preferred = candidate;
    }
    const mapReference = preferred ?? firstPlaying ?? first;
    if (mapReference === null) return null;

    // Synchronize to the slowest healthy POV on the selected map. A delayed
    // stream must never be sought forward beyond replay data it has received.
    const candidates: TimelineEntry[] = [];
    let slowest: TimelineEntry | null = null;
    let slowestTime = Number.POSITIVE_INFINITY;
    for (const id of this.playerOrder) {
      const entry = this.snapshots.get(id);
      if (
        entry === undefined ||
        entry.snapshot.duration <= 0 ||
        !entry.snapshot.playing ||
        !entry.snapshot.syncReady ||
        !sameMap(entry.snapshot, mapReference.entry.snapshot)
      )
        continue;
      const candidate = { id, entry };
      candidates.push(candidate);
      const time = sampleAt(entry, now).time;
      if (time < slowestTime) {
        slowest = candidate;
        slowestTime = time;
      }
    }
    if (slowest === null) {
      this.anchorId = mapReference.id;
      return mapReference;
    }
    const currentAnchor = candidates.find((candidate) => candidate.id === this.anchorId);
    // Keep the reference stable while the POVs remain within the allowed sync
    // window. Small clock differences must not influence normal rendering.
    if (
      currentAnchor !== undefined &&
      sampleAt(currentAnchor.entry, now).time <= slowestTime + multiviewSyncThresholdSeconds
    ) {
      return currentAnchor;
    }
    this.anchorId = slowest.id;
    return slowest;
  }

  primary(now = performance.now()): MultiviewTimelineSample | null {
    const primary = this.primaryEntry(now);
    return primary === null ? null : { id: primary.id, ...sampleAt(primary.entry, now) };
  }

  ownSample(id: string, now = performance.now()): MultiviewTimelineSample | null {
    const own = this.snapshots.get(id);
    return own === undefined || own.snapshot.duration <= 0 ? null : { id, ...sampleAt(own, now) };
  }

  sampleFor(id: string, now = performance.now()): MultiviewTimelineSample | null {
    return this.ownSample(id, now);
  }

  beatFor(id: string) {
    return this.sampleFor(id)?.beat ?? 0;
  }
}
