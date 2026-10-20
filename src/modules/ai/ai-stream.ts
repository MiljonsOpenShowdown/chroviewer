// Turns generated AI motion into a live replay stream: scores each note in the
// sim once the frames around it exist, then cuts 250 ms ReplayChunks that are
// only released when everything before their end time is final. Port of
// CyberHawk's pTrainer/ludus_mock/ai_play.py + server.py chunk slicing.

import { create, type MessageInitShape, toBinary } from '@bufbuild/protobuf';

import {
  ReplayCompletion,
  ReplayCompression,
  ReplayNoteEventType,
  ReplayPayloadFormat,
  ReplayPlatform,
  ReplayStreamPacketSchema,
  type ReplayNoteEventSchema,
} from '../live/generated/proto/scoresaber/live/v1/replay_stream_pb';
import {
  CUT_WINDOW_S,
  decodeScoringType,
  maxNoteScore,
  noteMotion,
  resampleFrames,
  type SimCutResult,
  type SimNote,
  simulateNotes,
  SWING_WINDOW_S,
  SWORD_OFFSET,
} from './ai-cut-sim';
import type { AiFrame } from './ai-generate';
import { item } from './ai-util';

export const CHUNK_SECONDS = 0.25;
const SCORE_MARGIN = CUT_WINDOW_S + SWING_WINDOW_S;
const FINAL_MARGIN = SCORE_MARGIN + CUT_WINDOW_S;
const ENERGY_START = 0.5;
// ScoreSaber note event types (1 good, 2 bad, 3 miss, 4 bomb) <- sim 0..3
const SS_EVENT = [
  ReplayNoteEventType.GOOD_CUT,
  ReplayNoteEventType.BAD_CUT,
  ReplayNoteEventType.MISS,
  ReplayNoteEventType.BOMB,
] as const;
const ENERGY_DELTA: Record<number, number> = {
  [ReplayNoteEventType.GOOD_CUT]: 0.01,
  [ReplayNoteEventType.BAD_CUT]: -0.1,
  [ReplayNoteEventType.MISS]: -0.15,
  [ReplayNoteEventType.BOMB]: -0.15,
};
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** Game multiplier: 1->2->4->8 after 2/4/8 good cuts, halves on a break (sim/ss_writer.py). */
class Multiplier {
  value = 1;
  progress = 0;
  good() {
    if (this.value >= 8) return;
    this.progress++;
    if (this.progress >= this.value * 2) {
      this.value *= 2;
      this.progress = 0;
    }
  }
  broken() {
    this.value = Math.max(1, Math.floor(this.value / 2));
    this.progress = 0;
  }
  get fraction() {
    return this.value < 8 ? this.progress / (this.value * 2) : 0;
  }
}

interface Timed<T> {
  time: number;
  value: T;
}

export interface AiStreamOptions {
  streamId: string;
  playerId: string;
  mapHash: string;
  difficultyRank: number;
  characteristic: string;
  simNotes: SimNote[];
  njs: number;
  height: number;
}

export interface AiStreamSummary {
  score: number;
  maxScore: number;
  goodCuts: number;
  badCuts: number;
  missedNotes: number;
  bombHits: number;
  maxCombo: number;
}

export class AiStreamBuilder {
  readonly options: AiStreamOptions;
  /** Song time up to which all events are final (Infinity once generation ended). */
  readyUntil = 0;
  finished = false;
  private frames: AiFrame[] = [];
  private simNotes: SimNote[];
  private nextNote = 0;
  private pending: SimCutResult[] = [];
  private poses: Timed<AiFrame>[] = [];
  private notes: Timed<MessageInitShape<typeof ReplayNoteEventSchema>>[] = [];
  private scores: Timed<[number, number]>[] = [];
  private combos: Timed<number>[] = [];
  private multipliers: Timed<[number, number]>[] = [];
  private energies: Timed<number>[] = [];
  private cursors = { poses: 0, notes: 0, scores: 0, combos: 0, multipliers: 0, energies: 0 };
  private chunkIndex = 0;
  private combo = 0;
  private maxCombo = 0;
  private score = 0;
  private maxScore = 0;
  private energy = ENERGY_START;
  private multiplier = new Multiplier();
  private multiplierMax = new Multiplier();
  private tallies = { good: 0, bad: 0, miss: 0, bomb: 0 };

  constructor(options: AiStreamOptions) {
    this.options = options;
    this.simNotes = [...options.simNotes].sort((a, b) => a.time - b.time);
  }

  private packet(body: MessageInitShape<typeof ReplayStreamPacketSchema>['body']) {
    return toBinary(
      ReplayStreamPacketSchema,
      create(ReplayStreamPacketSchema, { streamId: this.options.streamId, playerId: this.options.playerId, body }),
    );
  }

  startPacket() {
    const { mapHash, difficultyRank, characteristic, height, playerId } = this.options;
    const hash = mapHash.toUpperCase();
    const levelId = `custom_level_${hash}`;
    const now = BigInt(Date.now());
    return this.packet({
      case: 'start',
      value: {
        protocolVersion: 1,
        payloadFormat: ReplayPayloadFormat.SCORESABER_STREAM_V1,
        payloadCompression: ReplayCompression.NONE,
        clientStartTimeUnixMs: now,
        serverStartTimeUnixMs: now,
        player: { playerId, platform: ReplayPlatform.DEV },
        beatmap: { mapHash: hash, levelId, difficulty: difficultyRank, characteristic, modifiers: [] },
        replayMetadata: {
          replayVersion: '3.0.0',
          levelId,
          difficulty: difficultyRank,
          characteristic,
          environment: 'DefaultEnvironment',
          modifiers: [],
          noteSpawnOffset: 0,
          leftHanded: false,
          initialHeight: height,
          roomRotation: 0,
          roomCenter: { x: 0, y: 0, z: 0 },
          failTimeSeconds: 0,
          songSpeed: 1,
        },
      },
    });
  }

  /** New 60 Hz frames in song order. */
  addFrames(frames: AiFrame[]) {
    if (frames.length === 0) return;
    this.frames.push(...frames);
    for (const frame of frames) this.poses.push({ time: frame.time, value: frame });
    const generatedUntil = item(this.frames, this.frames.length - 1).time;
    this.scoreNotes(generatedUntil - SCORE_MARGIN);
    this.finalize(generatedUntil - FINAL_MARGIN);
    this.readyUntil = Math.max(this.readyUntil, generatedUntil - FINAL_MARGIN);
  }

  /** Generation is complete: score and release everything. */
  finish() {
    this.scoreNotes(Number.POSITIVE_INFINITY);
    this.finalize(Number.POSITIVE_INFINITY);
    this.readyUntil = Number.POSITIVE_INFINITY;
    this.finished = true;
  }

  get duration() {
    const last = (list: Timed<unknown>[]) => list[list.length - 1]?.time ?? 0;
    return Math.max(last(this.poses), last(this.notes), last(this.scores), last(this.energies));
  }

  get summary(): AiStreamSummary {
    return {
      score: this.score,
      maxScore: this.maxScore,
      goodCuts: this.tallies.good,
      badCuts: this.tallies.bad,
      missedNotes: this.tallies.miss,
      bombHits: this.tallies.bomb,
      maxCombo: this.maxCombo,
    };
  }

  private scoreNotes(spawnLimit: number) {
    const start = this.nextNote;
    let end = start;
    while (end < this.simNotes.length && item(this.simNotes, end).time <= spawnLimit) end++;
    if (end === start || this.frames.length === 0) return;
    const batch = this.simNotes.slice(start, end);
    this.nextNote = end;
    const windowStart = item(batch, 0).time - CUT_WINDOW_S - SWING_WINDOW_S - 0.2;
    const window = this.frames.filter((frame) => frame.time >= windowStart);
    const results = simulateNotes(resampleFrames(window), batch, this.options.njs, SWORD_OFFSET);
    // Untouched bombs are not events in real replays.
    this.pending.push(...results.filter((result) => result.eventType !== 4));
  }

  private finalize(ready: number) {
    const eventTime = (r: SimCutResult) => r.cutTime ?? r.spawnTime;
    const finalized = this.pending.filter((r) => eventTime(r) < ready).sort((a, b) => eventTime(a) - eventTime(b));
    this.pending = this.pending.filter((r) => eventTime(r) >= ready);
    for (const result of finalized) this.appendEvent(result, eventTime(result));
  }

  private appendEvent(r: SimCutResult, time: number) {
    const base = r.noteId % 10000;
    const lineIndex = Math.floor(base / 1000) % 10;
    const lineLayer = Math.floor(base / 100) % 10;
    const color = Math.floor(base / 10) % 10;
    const cutDirection = base % 10;
    const scoringType = decodeScoringType(r.noteId) || 3;
    const eventType = SS_EVENT[r.eventType as 0 | 1 | 2 | 3];
    const cutPos = noteMotion(lineIndex, lineLayer, r.spawnTime, this.options.njs)(time);
    const point = { x: cutPos[0], y: cutPos[1], z: cutPos[2] };
    this.notes.push({
      time,
      value: {
        noteId: {
          timeSeconds: r.spawnTime,
          lineLayer,
          lineIndex,
          colorType: eventType === ReplayNoteEventType.BOMB ? -1 : color,
          cutDirection,
          gameplayType: 0,
          scoringType: scoringType - 2,
          cutDirectionAngleOffset: 0,
        },
        eventType,
        cutPoint: point,
        cutNormal: { x: 0, y: 0, z: -1 },
        saberDirection: { x: 0, y: 0, z: 1 },
        saberType: r.saberType,
        directionOk: r.directionOk,
        saberSpeed: r.saberSpeed,
        cutAngle: 0,
        cutDistanceToCenter: r.cutDistanceToCenter,
        cutDirectionDeviation: r.cutDirDeviation,
        beforeCutRating: r.beforeCutRating,
        afterCutRating: r.afterCutRating,
        timeSeconds: time,
        unityTimescale: 1,
        timeSyncTimescale: 1,
        timeDeviation: r.timeDeviation,
        worldRotation: IDENTITY,
        inverseWorldRotation: IDENTITY,
        noteRotation: IDENTITY,
        notePosition: point,
      },
    });

    if (eventType === ReplayNoteEventType.GOOD_CUT) {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.multiplier.good();
      this.score += r.score * this.multiplier.value;
      this.tallies.good++;
    } else {
      this.combo = 0;
      this.multiplier.broken();
      if (eventType === ReplayNoteEventType.BAD_CUT) this.tallies.bad++;
      else if (eventType === ReplayNoteEventType.MISS) this.tallies.miss++;
      else this.tallies.bomb++;
    }
    if (eventType !== ReplayNoteEventType.BOMB) {
      this.multiplierMax.good();
      this.maxScore += maxNoteScore(scoringType) * this.multiplierMax.value;
    }
    this.energy = Math.min(1, Math.max(0, this.energy + (ENERGY_DELTA[eventType] ?? 0)));
    this.scores.push({ time, value: [this.score, this.maxScore] });
    this.combos.push({ time, value: this.combo });
    this.multipliers.push({ time, value: [this.multiplier.value, this.multiplier.fraction] });
    this.energies.push({ time, value: this.energy });
  }

  private take<T>(name: keyof AiStreamBuilder['cursors'], list: Timed<T>[], until: number) {
    let i = this.cursors[name];
    const out: Timed<T>[] = [];
    for (let next = list[i]; next !== undefined && next.time < until; next = list[++i]) out.push(next);
    this.cursors[name] = i;
    return out;
  }

  /** Total chunk count, known once generation has finished. */
  get totalChunks() {
    return this.finished ? Math.floor(this.duration / CHUNK_SECONDS) + 1 : null;
  }

  /** Next 250 ms chunk packet if its contents are final, else null. */
  nextChunkPacket() {
    const total = this.totalChunks;
    if (total !== null && this.chunkIndex >= total) return null;
    const end = (this.chunkIndex + 1) * CHUNK_SECONDS;
    if (end > this.readyUntil) return null;
    const index = this.chunkIndex++;
    const chunk = {
      cursor: {
        sequence: BigInt(index + 1),
        songTimeMs: BigInt(Math.round(end * 1000)),
        serverTimeUnixMs: BigInt(Date.now()),
      },
      events: {
        minTimeSeconds: index * CHUNK_SECONDS,
        maxTimeSeconds: end,
        poseFrames: this.take('poses', this.poses, end).map(({ value: frame }) => ({
          timeSeconds: frame.time,
          fps: 60,
          head: pose(frame.headPos, frame.headRot),
          left: pose(frame.leftPos, frame.leftRot),
          right: pose(frame.rightPos, frame.rightRot),
        })),
        noteEvents: this.take('notes', this.notes, end).map(({ value }) => value),
        scoreEvents: this.take('scores', this.scores, end).map(({ time, value: [score, max] }) => ({
          score,
          immediateMaxPossibleScore: max,
          timeSeconds: time,
        })),
        comboEvents: this.take('combos', this.combos, end).map(({ time, value }) => ({
          combo: value,
          timeSeconds: time,
        })),
        multiplierEvents: this.take('multipliers', this.multipliers, end).map(
          ({ time, value: [multiplier, progress] }) => ({
            multiplier,
            nextMultiplierProgress: progress,
            timeSeconds: time,
          }),
        ),
        energyEvents: this.take('energies', this.energies, end).map(({ time, value }) => ({
          energy: value,
          timeSeconds: time,
        })),
      },
    };
    return { index, bytes: this.packet({ case: 'chunk', value: chunk }) };
  }

  endPacket() {
    const s = this.summary;
    return this.packet({
      case: 'end',
      value: {
        cursor: { sequence: BigInt(this.chunkIndex + 1), songTimeMs: BigInt(Math.round(this.duration * 1000)) },
        completion: ReplayCompletion.PASSED,
        chunkCount: BigInt(this.chunkIndex),
        score: {
          score: s.score,
          modifiedScore: s.score,
          maxScore: s.maxScore,
          accuracy: s.maxScore > 0 ? s.score / s.maxScore : 0,
          combo: this.combo,
          maxCombo: s.maxCombo,
          fullCombo: s.badCuts === 0 && s.missedNotes === 0 && s.bombHits === 0,
          goodCuts: s.goodCuts,
          badCuts: s.badCuts,
          missedNotes: s.missedNotes,
          bombHits: s.bombHits,
          wallHits: 0,
        },
      },
    });
  }
}

function pose(position: [number, number, number], rotation: [number, number, number, number]) {
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
  };
}
