import type { SongClock } from '../../core/clock/song-clock';
import type { Replay } from '../../core/replay/types';
import { CoCuLiveSocketUrl, env, TALiveSocketUrl } from '../../env';
import type { ReplayStreamPacket } from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import type { LivePlaybackBuffer } from './generated/proto/scoresaber/live/v1/room_state_pb';
import type { ScheduledReplayPause } from './live-playback';
import type { LiveTarget } from './live-types';
import { ludusWebSocketUrl } from './ludus-protocol';

export const reconnectDelays = [500, 1000, 2000, 4000, 8000, 10_000];
export const maxBufferedPackets = 240;

const retainedHistorySeconds = 30;
const taRetainedHistorySeconds = 15;
const maxRetainedPoseFrames = 1800;
const maxBufferedPoseFramesPerSecond = 240;

function retainLatestBefore<T>(events: T[], cutoff: number, time: (event: T) => number) {
  let remove = 0;
  while (remove + 1 < events.length && time(events[remove + 1] as T) < cutoff) remove++;
  if (remove > 0) events.splice(0, remove);
}

export interface LiveRuntime {
  bufferedPackets: ReplayStreamPacket[];
  compositorBufferSeconds: number;
  compositorStartAligned: boolean;
  connectionId: string;
  currentStreamId: string;
  followRequested: boolean;
  heartbeatId: number;
  heartbeatIntervalMs: number;
  lastPlaybackDelayIncreaseAt: number;
  lastPruneAt: number;
  lastReceivedSequence: bigint;
  lastReplaySequence: bigint;
  latestFrameTime: number;
  latestSongTime: number;
  mapLoaded: boolean;
  outgoingSequence: bigint;
  pendingChatMessageIds: string[];
  pendingPauseEvents: ScheduledReplayPause[];
  playbackDelay: number;
  playbackClock: SongClock | null;
  playbackMaxDelay: number;
  playbackMinDelay: number;
  playbackRate: number;
  playbackAttemptPending: boolean;
  playbackRecommendedDelay: number;
  playbackStarted: boolean;
  reconnectAttempt: number;
  reconnectId: number;
  receivedPoseFrameCount: number;
  replay: Replay | null;
  sessionPlayerId: string;
  socket: WebSocket | null;
  streamEnding: boolean;
  streamPaused: boolean;
  taLive: boolean;
  taBufferingStartedAt: number;
  taLiveMapHash: string;
  taSyncHolding: boolean;
  targetMatchId: string;
  websocketUrl: string;
}

export function createLiveRuntime(target: LiveTarget): LiveRuntime {
  return {
    bufferedPackets: [],
    compositorBufferSeconds: 0,
    compositorStartAligned: false,
    connectionId: '',
    currentStreamId: '',
    followRequested: false,
    heartbeatId: 0,
    heartbeatIntervalMs: 5000,
    lastPlaybackDelayIncreaseAt: Number.NEGATIVE_INFINITY,
    lastPruneAt: 0,
    lastReceivedSequence: 0n,
    lastReplaySequence: 0n,
    latestFrameTime: 0,
    latestSongTime: 0,
    mapLoaded: false,
    outgoingSequence: 1n,
    pendingChatMessageIds: [],
    pendingPauseEvents: [],
    playbackDelay: 1,
    playbackClock: null,
    playbackMaxDelay: 6,
    playbackMinDelay: 1,
    playbackRate: 1,
    playbackAttemptPending: false,
    playbackRecommendedDelay: 1.5,
    playbackStarted: false,
    reconnectAttempt: 0,
    reconnectId: 0,
    receivedPoseFrameCount: 0,
    replay: null,
    sessionPlayerId: target.watcherPlayerId ?? '',
    socket: null,
    streamEnding: false,
    streamPaused: false,
    taLive: target.source === 'ta' || target.source === 'cocu',
    taBufferingStartedAt: 0,
    taLiveMapHash: '',
    taSyncHolding: false,
    targetMatchId: target.matchId ?? (target.roomId === undefined ? `player:${target.playerId}` : ''),
    websocketUrl:
      target.source === 'ta' || target.source === 'cocu'
        ? `${target.source === 'cocu' ? CoCuLiveSocketUrl : TALiveSocketUrl}/live/u/${encodeURIComponent(target.playerId)}`
        : ludusWebSocketUrl(env.VITE_LUDUS_URL),
  };
}

export function applyLivePlaybackBuffer(runtime: LiveRuntime, buffer: LivePlaybackBuffer | undefined) {
  if (buffer === undefined) return;
  runtime.playbackMinDelay = Math.max(0.05, buffer.minDelayMs / 1000);
  runtime.playbackMaxDelay = Math.max(runtime.playbackMinDelay, buffer.maxDelayMs / 1000);
  runtime.playbackRecommendedDelay = Math.min(
    runtime.playbackMaxDelay,
    Math.max(runtime.playbackMinDelay, (buffer.recommendedDelayMs || buffer.minDelayMs) / 1000),
  );
  runtime.playbackDelay = Math.min(runtime.playbackMaxDelay, Math.max(runtime.playbackDelay, runtime.playbackMinDelay));
}

export function resetLiveStream(runtime: LiveRuntime) {
  runtime.currentStreamId = '';
  runtime.compositorBufferSeconds = 0;
  runtime.compositorStartAligned = false;
  runtime.lastReplaySequence = 0n;
  runtime.latestFrameTime = 0;
  runtime.latestSongTime = 0;
  runtime.lastPruneAt = 0;
  runtime.mapLoaded = false;
  runtime.pendingPauseEvents = [];
  runtime.playbackAttemptPending = false;
  runtime.playbackClock = null;
  runtime.playbackRate = 1;
  runtime.playbackStarted = false;
  runtime.receivedPoseFrameCount = 0;
  runtime.replay = null;
  runtime.streamEnding = false;
  runtime.streamPaused = false;
  runtime.taLiveMapHash = '';
  runtime.taBufferingStartedAt = 0;
  runtime.taSyncHolding = false;
}

export function replayPacketTargetsPlayer(packet: ReplayStreamPacket, playerId: string) {
  let packetPlayerId = packet.playerId;
  if (packetPlayerId === '' && packet.body.case === 'start') {
    packetPlayerId = packet.body.value.player?.playerId ?? '';
  }
  return packetPlayerId === '' || packetPlayerId === playerId;
}

export function acceptLiveReplayPacket(runtime: LiveRuntime, packet: ReplayStreamPacket) {
  if (runtime.currentStreamId !== '' && packet.streamId !== runtime.currentStreamId) return false;
  const sequence =
    packet.body.case === 'chunk' || packet.body.case === 'end' ? (packet.body.value.cursor?.sequence ?? 0n) : 0n;
  if (sequence === 0n) return true;
  if (sequence <= runtime.lastReplaySequence) return false;
  if (runtime.lastReplaySequence > 0n && sequence > runtime.lastReplaySequence + 1n) increasePlaybackDelay(runtime);
  runtime.lastReplaySequence = sequence;
  return true;
}

export function increasePlaybackDelay(runtime: LiveRuntime) {
  const now = performance.now();
  if (now - runtime.lastPlaybackDelayIncreaseAt < 500) return;
  runtime.lastPlaybackDelayIncreaseAt = now;
  runtime.playbackDelay = Math.min(
    runtime.playbackMaxDelay,
    runtime.playbackDelay < runtime.playbackRecommendedDelay
      ? runtime.playbackRecommendedDelay
      : runtime.playbackDelay + 0.35,
  );
}

export function pruneLiveReplay(runtime: LiveRuntime, time: number) {
  const replay = runtime.replay;
  if (replay === null) return;
  const retainedSeconds = runtime.taLive ? taRetainedHistorySeconds : retainedHistorySeconds;
  // TA can play far behind incoming data, including after a compositor timeout.
  // Keep every unread pose; only the consumer's clock can retire its history.
  const playhead =
    runtime.taLive || runtime.compositorBufferSeconds > 0
      ? (runtime.playbackClock?.currentTime() ?? replay.poses[0]?.time ?? 0)
      : time;
  const pruneTime = runtime.taLive ? playhead : time;
  const frameLimit =
    runtime.compositorBufferSeconds > 0
      ? Math.ceil(
          (runtime.compositorBufferSeconds + (retainedSeconds + 5) / runtime.playbackRate) *
            maxBufferedPoseFramesPerSecond,
        )
      : maxRetainedPoseFrames;
  if (pruneTime - runtime.lastPruneAt < 2 && (runtime.taLive || replay.poses.length <= frameLimit)) return;
  runtime.lastPruneAt = pruneTime;
  const cutoff = runtime.taLive
    ? playhead - retainedSeconds
    : Math.max(
        playhead - retainedSeconds,
        runtime.compositorBufferSeconds > 0
          ? runtime.latestFrameTime - runtime.compositorBufferSeconds * runtime.playbackRate - retainedSeconds - 5
          : Number.NEGATIVE_INFINITY,
      );
  if (cutoff > 0) {
    let poseIndex = 0;
    while (poseIndex + 1 < replay.poses.length && (replay.poses[poseIndex + 1]?.time ?? 0) < cutoff) poseIndex++;
    if (poseIndex > 0) replay.poses.splice(0, poseIndex);
  }
  if (!runtime.taLive && replay.poses.length > frameLimit) {
    replay.poses.splice(0, replay.poses.length - frameLimit);
  }
  if (cutoff <= 0) return;
  const base = (replay.liveHistoryBase ??= {
    scoringNotes: 0,
    misses: 0,
    badCuts: 0,
    bombCuts: 0,
    wallsHit: 0,
    maxCombo: 0,
  });
  let noteCount = 0;
  while (noteCount < replay.notes.length && (replay.notes[noteCount]?.time ?? 0) < cutoff) {
    const eventType = replay.notes[noteCount]?.eventType;
    if (eventType !== undefined && eventType >= 1 && eventType <= 3) base.scoringNotes++;
    if (eventType === 2) base.badCuts++;
    if (eventType === 3) base.misses++;
    if (eventType === 4) base.bombCuts++;
    noteCount++;
  }
  if (noteCount > 0) replay.notes.splice(0, noteCount);
  let wallCount = 0;
  while (wallCount < replay.walls.length && (replay.walls[wallCount]?.time ?? 0) < cutoff) wallCount++;
  if (wallCount > 0) {
    base.wallsHit += wallCount;
    replay.walls.splice(0, wallCount);
  }
  for (const combo of replay.combos) {
    if (combo.time >= cutoff) break;
    base.maxCombo = Math.max(base.maxCombo, combo.combo);
  }
  retainLatestBefore(replay.scores, cutoff, (event) => event.time);
  retainLatestBefore(replay.combos, cutoff, (event) => event.time);
  retainLatestBefore(replay.multipliers, cutoff, (event) => event.time);
  retainLatestBefore(replay.energies, cutoff, (event) => event.time);
  retainLatestBefore(replay.heights, cutoff, (event) => event.time);
  const retainedPause = replay.pauses.findIndex((event) => event.time >= cutoff || event.duration === 0n);
  replay.pauses.splice(0, retainedPause < 0 ? replay.pauses.length : retainedPause);
}
