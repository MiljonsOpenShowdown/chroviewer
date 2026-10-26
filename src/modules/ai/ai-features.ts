// Model inputs for the built-in AI. Port of the inference half of
// pTrainer/replay_ai/features.py (MOSes); keep the two in step, the
// exported model only understands features built exactly this way.

import { item } from './ai-util';

export const TARGET_FPS = 60;
export const HISTORY_FRAMES = 30;
export const PREDICTION_FRAMES = 30;
export const NOTE_SLOTS = 30;
export const NOTE_FEATURES = 21;
export const MODEL_INPUT_FEATURES = 28;
export const MODEL_OUTPUT_FEATURES = 27;
export const ENVIRONMENT_FEATURES = 5;
// Head position, left hand relative to head, right hand relative to head.
export const POSITION_INDICES = [0, 1, 2, 9, 10, 11, 18, 19, 20] as const;

const NOTE_LOOKAHEAD_SECONDS = 2;
const WALL_LOOKAHEAD_SECONDS = 0.6;
const WALL_ZONES: [number, number][] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
];

/** [time seconds, line index, line layer, color (0/1, 2 = bomb), cut direction (9 = bomb)] */
export type AiNote = [number, number, number, number, number];
/** [start seconds, duration seconds, x, y, width, height] */
export type AiWall = [number, number, number, number, number, number];

export interface PositionStats {
  mean: number[];
  std: number[];
}

/** Round to the nearest IEEE half-precision value (ties to even), like a numpy float16 store. */
export function f16round(value: number) {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  const exponent = Math.max(Math.floor(Math.log2(magnitude)), -14);
  const step = 2 ** (exponent - 10);
  const scaled = magnitude / step;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  return Math.sign(value) * Math.min(rounded * step, 65504);
}

function clip(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

export function encodeNote(note: AiNote, timeOffset: number, out: Float32Array, offset: number) {
  out[offset] = timeOffset;
  out[offset + 1 + clip(note[1], 0, 3)] = 1;
  out[offset + 5 + clip(note[2], 0, 2)] = 1;
  out[offset + 8 + clip(note[3], 0, 2)] = 1;
  out[offset + 11 + clip(note[4], 0, 9)] = 1;
}

/** Distinct time/color pairs per second, scaled by 1/10 (features.note_density). */
export function noteDensity(notes: AiNote[]) {
  const pairs = new Set<string>();
  for (const note of notes) {
    if (note[3] !== 0 && note[3] !== 1) continue;
    pairs.add(`${Math.round(note[0] * 1000)}:${note[3]}`);
  }
  if (pairs.size === 0) return 0;
  return pairs.size / 2 / 10;
}

/** Upcoming notes in (time, time + 2 s] as NOTE_SLOTS x NOTE_FEATURES, plus density and their indices. */
export function noteFeatures(notes: AiNote[], predictionTime: number) {
  const features = new Float32Array(NOTE_SLOTS * NOTE_FEATURES);
  const upcoming: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const time = item(notes, i)[0];
    if (time > predictionTime && time <= predictionTime + NOTE_LOOKAHEAD_SECONDS) upcoming.push(i);
  }
  if (upcoming.length === 0) return { features, density: 0, upcoming };
  const density = noteDensity(upcoming.map((i) => item(notes, i)));
  upcoming.slice(0, NOTE_SLOTS).forEach((noteIndex, slot) => {
    const note = item(notes, noteIndex);
    encodeNote(note, note[0] - predictionTime, features, slot * NOTE_FEATURES);
  });
  return { features, density, upcoming };
}

/** 4 wall-zone occupancy values per output frame (features.wall_features), float16-rounded. */
export function wallFeatures(walls: AiWall[], startTime: number, frames = PREDICTION_FRAMES) {
  const features = new Float64Array(frames * 4);
  if (walls.length === 0) return features;
  const times = Array.from({ length: frames }, (_, i) => startTime + i / TARGET_FPS);
  const windowEnd = startTime + frames / TARGET_FPS;
  for (const [wallTime, wallDuration, x, y, width, height] of walls) {
    if (!(wallTime < windowEnd + WALL_LOOKAHEAD_SECONDS && wallTime + wallDuration > startTime)) continue;
    WALL_ZONES.forEach(([zoneX, zoneY], zone) => {
      if (!(x <= zoneX && zoneX < x + width && y <= zoneY && zoneY < y + height)) return;
      times.forEach((time, frame) => {
        const index = frame * 4 + zone;
        if (time >= wallTime && time < wallTime + wallDuration) features[index] = 1;
        else if (time >= wallTime - WALL_LOOKAHEAD_SECONDS && time < wallTime) {
          const ramp = f16round(1 - (wallTime - time) / WALL_LOOKAHEAD_SECONDS);
          features[index] = Math.max(item(features, index), ramp);
        }
      });
    });
  }
  return features;
}

/** Inference-time environment input: walls x2 plus note density (environment_features(inference_scaling=True)). */
export function environmentFeatures(walls: AiWall[], predictionTime: number, density: number) {
  const wallValues = wallFeatures(walls, predictionTime);
  const out = new Float32Array(PREDICTION_FRAMES * ENVIRONMENT_FEATURES);
  for (let frame = 0; frame < PREDICTION_FRAMES; frame++) {
    for (let zone = 0; zone < 4; zone++) {
      out[frame * ENVIRONMENT_FEATURES + zone] = item(wallValues, frame * 4 + zone) * 2;
    }
    out[frame * ENVIRONMENT_FEATURES + 4] = density;
  }
  return out;
}

export function normalizePositions(frame: ArrayLike<number>, stats: PositionStats) {
  const out = Array.from(frame);
  POSITION_INDICES.forEach((index, statsIndex) => {
    out[index] = (item(out, index) - item(stats.mean, statsIndex)) / item(stats.std, statsIndex);
  });
  return out;
}

export function denormalizePositions(frame: ArrayLike<number>, stats: PositionStats) {
  const out = Array.from(frame);
  POSITION_INDICES.forEach((index, statsIndex) => {
    out[index] = item(out, index) * item(stats.std, statsIndex) + item(stats.mean, statsIndex);
  });
  return out;
}

type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

function normalize3(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) + 1e-8;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** 6D rotation (two matrix columns) -> quaternion [x, y, z, w] via Gram-Schmidt. */
export function rotation6dToQuaternion(r: ArrayLike<number>): Quat {
  const first = normalize3([item(r, 0), item(r, 1), item(r, 2)]);
  const dot = first[0] * item(r, 3) + first[1] * item(r, 4) + first[2] * item(r, 5);
  const second = normalize3([item(r, 3) - dot * first[0], item(r, 4) - dot * first[1], item(r, 5) - dot * first[2]]);
  const third: Vec3 = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  // Columns of the rotation matrix are first, second, third.
  const [m00, m10, m20] = first;
  const [m01, m11, m21] = second;
  const [m02, m12, m22] = third;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return [x / length, y / length, z / length, w / length];
}
