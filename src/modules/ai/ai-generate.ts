// Whole-map motion generation. Port of iter_motion_chunks / reconstruct_frames
// in pTrainer/replay_ai/inference.py: the model predicts 30 frames (0.5 s) at a
// time from its own previous output, so the map is played open-loop.

import {
  type AiNote,
  type AiWall,
  denormalizePositions,
  environmentFeatures,
  HISTORY_FRAMES,
  MODEL_INPUT_FEATURES,
  MODEL_OUTPUT_FEATURES,
  normalizePositions,
  noteFeatures,
  POSITION_INDICES,
  type PositionStats,
  PREDICTION_FRAMES,
  type Quat,
  rotation6dToQuaternion,
  TARGET_FPS,
} from './ai-features';
import { item } from './ai-util';

export const START_TIME = -1;
export const DEFAULT_PLAYER_HEIGHT = 1.65;
// Open-loop play drifts: each chunk continues from the previous one's output, so a
// small depth bias adds up to ~1 m over a long song and the sabers end up cutting
// behind the notes. Past these limits the body is eased back (inference.py).
const DRIFT_LIMIT_X = 0.4;
const DRIFT_LIMIT_Z = 0.25;

/** One model call: normalized history (30x28), notes (30x21), environment (30x5) -> 30x27. */
export type RunChunk = (history: Float32Array, notes: Float32Array, environment: Float32Array) => Promise<Float32Array>;

export interface AiFrame {
  time: number;
  headPos: [number, number, number];
  headRot: Quat;
  leftPos: [number, number, number];
  leftRot: Quat;
  rightPos: [number, number, number];
  rightRot: Quat;
}

export interface GenerateOptions {
  notes: AiNote[];
  walls: AiWall[];
  seed: number[];
  stats: PositionStats;
  height?: number;
  /** Gaussian source for history noise; null turns the noise off (tests). */
  random?: (() => number) | null;
}

/** Small deterministic PRNG (mulberry32) + Box-Muller, for reproducible history noise. */
export function seededGaussian(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
}

/** Song length the model plays: last note + 2 s (inference.py). */
export function generationDuration(notes: AiNote[]) {
  return notes.length > 0 ? item(notes, notes.length - 1)[0] + 2 : 10;
}

/**
 * Keeps the head (and the hands, stored relative to it) near home = raw [x, z].
 * Port of anchor_drift in inference.py: when the normalized 30x27 chunk ends past a
 * limit, the excess is removed along a ramp (none at the first frame, all at the
 * last), so the chunk still joins the previous one. Modifies the chunk in place.
 */
export function anchorDrift(chunk: Float32Array, home: [number, number], stats: PositionStats) {
  // head x and z: frame columns 0 and 2, which are also position stats 0 and 2
  for (const [column, limit, homeValue] of [
    [0, DRIFT_LIMIT_X, home[0]],
    [2, DRIFT_LIMIT_Z, home[1]],
  ] as const) {
    const std = item(stats.std, column);
    const last = item(chunk, (PREDICTION_FRAMES - 1) * MODEL_OUTPUT_FEATURES + column);
    const offset = last * std + item(stats.mean, column) - homeValue;
    const excess = offset - Math.min(Math.max(offset, -limit), limit);
    if (excess === 0) continue;
    for (let frame = 0; frame < PREDICTION_FRAMES; frame++) {
      const k = frame * MODEL_OUTPUT_FEATURES + column;
      chunk[k] = item(chunk, k) - ((frame + 1) / PREDICTION_FRAMES) * (excess / std);
    }
  }
  return chunk;
}

/** Yields each predicted chunk (still normalized) in song order. */
export async function* generateChunks(runChunk: RunChunk, options: GenerateOptions) {
  const { notes, walls, stats } = options;
  const height = options.height ?? DEFAULT_PLAYER_HEIGHT;
  const random = options.random === undefined ? seededGaussian(0) : options.random;
  const seed = normalizePositions(options.seed, stats);
  const home: [number, number] = [item(options.seed, 0), item(options.seed, 2)];
  let history = new Float32Array(HISTORY_FRAMES * MODEL_INPUT_FEATURES);
  for (let frame = 0; frame < HISTORY_FRAMES; frame++) history.set(seed, frame * MODEL_INPUT_FEATURES);

  const duration = generationDuration(notes);
  for (let time = START_TIME; time < duration; time += PREDICTION_FRAMES / TARGET_FPS) {
    const { features: noteInput, density, upcoming } = noteFeatures(notes, time);
    const environment = environmentFeatures(walls, time, density);

    const input = new Float32Array(history);
    if (random !== null) {
      const nearby = upcoming.slice(0, 10).filter((index) => item(notes, index)[0] < time + 1).length;
      const level = Math.min(0.002 + 0.02 * nearby, 0.2);
      for (let frame = 0; frame < HISTORY_FRAMES - 1; frame++) {
        const scale = frame >= HISTORY_FRAMES - 5 ? 0.5 : 1;
        for (const index of POSITION_INDICES) {
          const k = frame * MODEL_INPUT_FEATURES + index;
          input[k] = (input[k] ?? 0) + random() * level * scale;
        }
      }
    }

    const chunk = anchorDrift(await runChunk(input, noteInput, environment), home, stats);
    yield chunk;

    history = new Float32Array(HISTORY_FRAMES * MODEL_INPUT_FEATURES);
    for (let frame = 0; frame < PREDICTION_FRAMES; frame++) {
      history.set(
        chunk.subarray(frame * MODEL_OUTPUT_FEATURES, (frame + 1) * MODEL_OUTPUT_FEATURES),
        frame * MODEL_INPUT_FEATURES,
      );
      history[frame * MODEL_INPUT_FEATURES + MODEL_INPUT_FEATURES - 1] = height;
    }
  }
}

/** World-space frames for one chunk; firstIndex = chunk position in the whole sequence (frames). */
export function reconstructFrames(chunk: Float32Array, stats: PositionStats, firstIndex: number) {
  const frames: AiFrame[] = [];
  for (let k = 0; k < PREDICTION_FRAMES; k++) {
    const time = START_TIME + (firstIndex + k) / TARGET_FPS;
    if (time < 0) continue;
    const motion = denormalizePositions(
      chunk.subarray(k * MODEL_OUTPUT_FEATURES, (k + 1) * MODEL_OUTPUT_FEATURES),
      stats,
    );
    const head: [number, number, number] = [item(motion, 0), item(motion, 1), item(motion, 2)];
    frames.push({
      time,
      headPos: head,
      headRot: rotation6dToQuaternion(motion.slice(3, 9)),
      leftPos: [item(motion, 9) + head[0], item(motion, 10) + head[1], item(motion, 11) + head[2]],
      leftRot: rotation6dToQuaternion(motion.slice(12, 18)),
      rightPos: [item(motion, 18) + head[0], item(motion, 19) + head[1], item(motion, 20) + head[2]],
      rightRot: rotation6dToQuaternion(motion.slice(21, 27)),
    });
  }
  return frames;
}
