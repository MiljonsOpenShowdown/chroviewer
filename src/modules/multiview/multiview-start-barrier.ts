export type CompositorSyncType = 'slow' | 'wait-for-all';
export const defaultCompositorWaitSeconds = 30;
export const maximumCompositorWaitSeconds = 60;

interface SyncPlayer {
  id: string;
  playerId: string;
  visible: boolean;
  settings: Record<string, string | number | boolean>;
}

export function compositorSyncSettings(players: SyncPlayer[]) {
  const visible = players.filter((player) => player.visible);
  const type: CompositorSyncType =
    visible.length > 0 && visible.every((player) => player.settings.compositorSyncType === 'wait-for-all')
      ? 'wait-for-all'
      : 'slow';
  const waitSeconds = Math.min(
    ...visible.map((player) => {
      const value = Number(player.settings.compositorWaitSeconds ?? defaultCompositorWaitSeconds);
      return Number.isFinite(value)
        ? Math.min(maximumCompositorWaitSeconds, Math.max(1, value))
        : defaultCompositorWaitSeconds;
    }),
    maximumCompositorWaitSeconds,
  );
  return { type, waitSeconds };
}

export interface BufferedStartParticipant {
  ready: boolean;
  firstFrameTime: number;
  latestFrameTime: number;
  playbackRate: number;
  minimumBufferSeconds?: number;
  start: (time: number, startedAt: number) => void;
}

interface Member {
  mapKey: string;
  streamId: string;
  participant?: BufferedStartParticipant;
}

type BarrierPhase = 'idle' | 'waiting' | 'released' | 'fallback';

/** A startup-only barrier. No timers or seeks are used once playback has begun. */
export class MultiviewStartBarrier {
  private ids: string[] = [];
  private signature = '';
  private type: CompositorSyncType = 'slow';
  private members = new Map<string, Member>();
  private phase: BarrierPhase = 'idle';
  private mapKey = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  waitSeconds = defaultCompositorWaitSeconds;

  constructor(private readonly now: () => number = () => performance.now()) {}

  configure(players: SyncPlayer[]) {
    const settings = compositorSyncSettings(players);
    const visible = players.filter((player) => player.visible);
    const signature = JSON.stringify({ settings, players: visible.map((player) => [player.id, player.playerId]) });
    if (signature === this.signature) return;
    this.signature = signature;
    this.release(false);
    this.type = settings.type;
    this.waitSeconds = settings.waitSeconds;
    this.ids = visible.map((player) => player.id);
    this.members.clear();
    this.phase = 'idle';
  }

  get enabled() {
    return this.type === 'wait-for-all';
  }

  begin(id: string, streamId: string, mapKey: string) {
    if (!this.enabled || !this.ids.includes(id)) return;
    const previous = this.members.get(id);
    if (previous?.streamId === streamId && previous.mapKey === mapKey) return;
    if (
      this.phase === 'idle' ||
      ((this.phase === 'released' || this.phase === 'fallback') && (previous !== undefined || this.mapKey !== mapKey))
    ) {
      this.clearTimer();
      this.members.clear();
      this.mapKey = mapKey;
      this.phase = 'waiting';
      this.timer = setTimeout(() => this.release(false), this.waitSeconds * 1000);
    }
    this.members.set(id, { mapKey, streamId });
    if (this.phase === 'waiting' && mapKey !== this.mapKey) this.release(false);
  }

  isWaitingFor(id: string, streamId: string) {
    return this.phase === 'waiting' && this.members.get(id)?.streamId === streamId;
  }

  /** Called by existing stream/buffer ticks, never by the WebGL frame loop. */
  update(id: string, streamId: string, participant: BufferedStartParticipant) {
    const member = this.members.get(id);
    if (member?.streamId !== streamId || this.phase !== 'waiting') return false;
    member.participant = participant;
    const ready = this.ids.map((key) => this.members.get(key)?.participant);
    if (ready.every((entry): entry is BufferedStartParticipant => entry?.ready === true)) {
      const first = ready[0];
      if (first !== undefined && ready.every((entry) => entry.playbackRate === first.playbackRate)) {
        const target = Math.max(0, ...ready.map((entry) => entry.firstFrameTime));
        if (ready.every((entry) => entry.latestFrameTime - target >= (entry.minimumBufferSeconds ?? 0.05)))
          this.release(true);
      } else this.release(false);
    }
    return this.phase === 'waiting';
  }

  private release(aligned: boolean) {
    if (this.phase !== 'waiting') return;
    this.clearTimer();
    this.phase = aligned ? 'released' : 'fallback';
    const ready = [...this.members.values()]
      .map((member) => member.participant)
      .filter((entry): entry is BufferedStartParticipant => entry?.ready === true);
    const target = Math.max(0, ...ready.map((entry) => entry.firstFrameTime));
    // Never start beyond data a stream has received. Incompatible buffers use normal startup.
    if (aligned && ready.some((entry) => entry.latestFrameTime < target + 0.05)) {
      this.phase = 'fallback';
      return;
    }
    const startedAt = this.now();
    if (aligned) for (const entry of ready) entry.start(target, startedAt);
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose() {
    this.release(false);
    this.clearTimer();
    this.members.clear();
  }
}
