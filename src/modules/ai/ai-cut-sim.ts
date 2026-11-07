// Saber/note cut simulation for AI play. Port of MOSes's
// pTrainer/sim/{cut_sim,note_motion,scoring}.py and preprocessor.resample_frames,
// which reproduce the game's cut pipeline (game 1.40.8: NoteCutter, GameNoteController,
// NoteJump, NoteBasicCutInfoHelper, SaberMovementData, SaberSwingRatingCounter).
// Keep in step with those files.

import type { Quat } from './ai-features';
import type { AiFrame } from './ai-generate';
import { item } from './ai-util';

type Vec3 = [number, number, number];
type Axes = [Vec3, Vec3, Vec3];

const SABER_LENGTH = 1;
const MIN_SABER_SPEED = 2;
const CUT_ANGLE_TOLERANCE = 60;
const PRE_FULL_DEG = 100;
const POST_FULL_DEG = 60;
export const SWING_WINDOW_S = 0.4;
export const CUT_WINDOW_S = 0.45;
export const SWORD_OFFSET = 0.9;
export const SIM_RATE = 90;
// NoteJump.kMissedTimeOffset: colliders off, note missed, at noteTime + this
const MISSED_TIME_OFFSET = 0.15;
// Note colliders (note-local half extents): big box = good cuts only, small box = any cut
const BIG_HALF: Vec3 = [0.4, 0.3, 0.5];
const SMALL_HALF: Vec3 = [0.175, 0.175, 0.175];
const BIG_RADIUS = Math.hypot(...BIG_HALF);
const ROTATION_ANGLE: Record<number, number> = { 0: 180, 1: 0, 2: 270, 3: 90, 4: 225, 5: 135, 6: 315, 7: 45 };
// NoteJump._randomRotations: middle-of-jump tilt (x20 deg) for normal notes
const RANDOM_ROTATIONS: readonly Vec3[] = [
  [-0.9543871, -0.1183784, 0.2741019],
  [0.7680854, -0.08805521, 0.6342642],
  [-0.6780157, 0.306681, -0.6680131],
  [0.1255014, 0.9398643, 0.3176546],
  [0.365105, -0.3664974, -0.8557909],
  [-0.8790653, -0.06244748, -0.4725934],
  [0.01886305, -0.8065798, 0.5908241],
  [-0.1455435, 0.8901445, 0.4318099],
  [0.07651193, 0.9474725, -0.3105508],
  [0.1306983, -0.2508438, -0.9591639],
];
// Scoring types that are chain heads: spawned as BurstSliderHead, no turn toward the player
const CHAIN_HEAD_TYPES = new Set([6, 9, 11, 12]);

/**
 * Map note for the sim: noteId = line*1000 + layer*100 + color*10 + direction (color 3 = bomb).
 * angleOffset: v3 colour note `a` (or the game's same-colour pair turn), degrees.
 */
export interface SimNote {
  noteId: number;
  time: number;
  angleOffset?: number;
}

/** 0 good, 1 bad cut, 2 miss, 3 bomb hit, 4 bomb avoided */
export type SimEventType = 0 | 1 | 2 | 3 | 4;

export interface SimCutResult {
  noteId: number;
  spawnTime: number;
  eventType: SimEventType;
  cutTime: number | null;
  saberType: number;
  saberSpeed: number;
  directionOk: boolean;
  cutDirDeviation: number;
  cutDistanceToCenter: number;
  timeDeviation: number;
  beforeCutRating: number;
  afterCutRating: number;
  score: number;
}

// ── vectors ─────────────────────────────────────────────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(a: Vec3): Vec3 {
  const m = len(a);
  return m < 1e-9 ? [0, 0, 1] : [a[0] / m, a[1] / m, a[2] / m];
}
function angleDeg(a: Vec3, b: Vec3) {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI;
}
function quatRotZ(q: Quat, length: number): Vec3 {
  const [x, y, z, w] = q;
  return [2 * (x * z + w * y) * length, 2 * (y * z - w * x) * length, (1 - 2 * (x * x + y * y)) * length];
}

// ── quaternions [x, y, z, w], Unity conventions ──────────────────────────────

const Q_ID: Quat = [0, 0, 0, 1];

function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function qAxis(axis: 0 | 1 | 2, deg: number): Quat {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0, Math.cos(h)];
}
/** Quaternion.Euler: z, then x, then y. */
const qEuler = (x: number, y: number, z: number) => qMul(qMul(qAxis(1, y), qAxis(0, x)), qAxis(2, z));
function qRot(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, q[3])), cross(u, t));
}
function qNorm(q: Quat): Quat {
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  return m < 1e-9 ? Q_ID : [q[0] / m, q[1] / m, q[2] / m, q[3] / m];
}
const qDot = (a: Quat, b: Quat) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qNeg = (q: Quat): Quat => [-q[0], -q[1], -q[2], -q[3]];
/** Quaternion.Lerp (t clamped, shortest path, normalised). */
function qNlerp(a: Quat, bIn: Quat, tIn: number): Quat {
  const t = Math.max(0, Math.min(1, tIn));
  const b = qDot(a, bIn) < 0 ? qNeg(bIn) : bIn;
  return qNorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
}
/** Quaternion.Slerp (t clamped, shortest path). */
function qSlerp(a: Quat, bIn: Quat, tIn: number): Quat {
  const t = Math.max(0, Math.min(1, tIn));
  let d = qDot(a, bIn);
  let b = bIn;
  if (d < 0) {
    b = qNeg(bIn);
    d = -d;
  }
  if (d > 0.9995) return qNlerp(a, b, t);
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}
/** Rotation whose local x/y/z axes are the given orthonormal world vectors. */
function qFromAxes([x, y, z]: Axes): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return qNorm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qNorm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qNorm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qNorm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}
/** Quaternion.LookRotation axes: z = forward, x = up × z, y = z × x. */
function lookAxes(forward: Vec3, up: Vec3): Axes {
  const z = norm(forward);
  let x = cross(up, z);
  if (len(x) < 1e-6) x = cross(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], z);
  x = norm(x);
  return [x, cross(z, x), z];
}
const qAxes = (q: Quat): Axes => [qRot(q, [1, 0, 0]), qRot(q, [0, 1, 0]), qRot(q, [0, 0, 1])];

// ── oriented box overlap (Physics.OverlapBox between two boxes) ───────────────

/** Separating-axis test, boxes as (centre, 3 unit axes, half extents). Ericson, RTCD 4.4.1. */
function obbOverlap(ca: Vec3, A: Axes, ea: Vec3, cb: Vec3, B: Axes, eb: Vec3) {
  const tw = sub(cb, ca);
  const r = (i: 0 | 1 | 2): Vec3 => [dot(A[i], B[0]), dot(A[i], B[1]), dot(A[i], B[2])];
  const R0 = r(0);
  const R1 = r(1);
  const R2 = r(2);
  const q = (v: Vec3): Vec3 => [Math.abs(v[0]) + 1e-6, Math.abs(v[1]) + 1e-6, Math.abs(v[2]) + 1e-6];
  const Q0 = q(R0);
  const Q1 = q(R1);
  const Q2 = q(R2);
  const t: Vec3 = [dot(tw, A[0]), dot(tw, A[1]), dot(tw, A[2])];
  // A's axes
  if (Math.abs(t[0]) > ea[0] + dot(eb, Q0)) return false;
  if (Math.abs(t[1]) > ea[1] + dot(eb, Q1)) return false;
  if (Math.abs(t[2]) > ea[2] + dot(eb, Q2)) return false;
  // B's axes
  for (const j of [0, 1, 2] as const) {
    const proj = t[0] * R0[j] + t[1] * R1[j] + t[2] * R2[j];
    if (Math.abs(proj) > ea[0] * Q0[j] + ea[1] * Q1[j] + ea[2] * Q2[j] + eb[j]) return false;
  }
  // cross products
  if (Math.abs(t[2] * R1[0] - t[1] * R2[0]) > ea[1] * Q2[0] + ea[2] * Q1[0] + eb[1] * Q0[2] + eb[2] * Q0[1]) return false;
  if (Math.abs(t[2] * R1[1] - t[1] * R2[1]) > ea[1] * Q2[1] + ea[2] * Q1[1] + eb[0] * Q0[2] + eb[2] * Q0[0]) return false;
  if (Math.abs(t[2] * R1[2] - t[1] * R2[2]) > ea[1] * Q2[2] + ea[2] * Q1[2] + eb[0] * Q0[1] + eb[1] * Q0[0]) return false;
  if (Math.abs(t[0] * R2[0] - t[2] * R0[0]) > ea[0] * Q2[0] + ea[2] * Q0[0] + eb[1] * Q1[2] + eb[2] * Q1[1]) return false;
  if (Math.abs(t[0] * R2[1] - t[2] * R0[1]) > ea[0] * Q2[1] + ea[2] * Q0[1] + eb[0] * Q1[2] + eb[2] * Q1[0]) return false;
  if (Math.abs(t[0] * R2[2] - t[2] * R0[2]) > ea[0] * Q2[2] + ea[2] * Q0[2] + eb[0] * Q1[1] + eb[1] * Q1[0]) return false;
  if (Math.abs(t[1] * R0[0] - t[0] * R1[0]) > ea[0] * Q1[0] + ea[1] * Q0[0] + eb[1] * Q2[2] + eb[2] * Q2[1]) return false;
  if (Math.abs(t[1] * R0[1] - t[0] * R1[1]) > ea[0] * Q1[1] + ea[1] * Q0[1] + eb[0] * Q2[2] + eb[2] * Q2[0]) return false;
  if (Math.abs(t[1] * R0[2] - t[0] * R1[2]) > ea[0] * Q1[2] + ea[1] * Q0[2] + eb[0] * Q2[1] + eb[1] * Q2[0]) return false;
  return true;
}

// ── note motion (sim/note_motion.py) ──────────────────────────────────────────

const gridX = (lineIndex: number) => (lineIndex - 1.5) * 0.6;
const gridY = (lineLayer: number) => 0.25 + 0.6 * lineLayer;
const highestJumpPosY = (lineLayer: number) => 0.6 * (lineLayer + 1) + 0.05 * (5 - lineLayer - (lineLayer > 1 ? 1 : 0));

export function noteMotion(
  lineIndex: number,
  lineLayer: number,
  eventTime: number,
  njs: number,
  zAtArrival = SWORD_OFFSET,
) {
  const halfJumpDuration = 0.5;
  const xFinal = gridX(lineIndex);
  const yFinal = highestJumpPosY(lineLayer);
  const gravity = (2 * (yFinal - gridY(lineLayer))) / (halfJumpDuration * halfJumpDuration);
  return (t: number): Vec3 => {
    const dt = eventTime - t;
    const z = dt * njs + zAtArrival;
    const y = dt > 0 && dt < halfJumpDuration ? yFinal - 0.5 * gravity * dt * dt : yFinal;
    return [xFinal, y, z];
  };
}

/** Python's round(): half to even. Also C# Mathf.RoundToInt. */
function roundHalfEven(value: number) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// ── note rotation (NoteJump.Init / ManualUpdate) ─────────────────────────────

/**
 * Note rotation over the jump. Normal notes: identity → middle (end + random tilt) → end
 * (cut direction + angle offset), blended toward LookRotation(note - head) by 2t; frozen from
 * t = 0.5 (the note reaches the player). Chain heads: no tilt, no look-at.
 * halfJumpDuration null = every time is treated as the arrival rotation.
 */
function noteRotation(rotZ: number, noteTime: number, halfJumpDuration: number | null, endX: number, endY: number, normal: boolean) {
  const end = qEuler(0, 0, rotZ);
  let middle = end;
  if (normal) {
    const r = item(RANDOM_ROTATIONS, Math.abs(roundHalfEven(noteTime * 10 + endX * 2 + endY * 2)) % RANDOM_ROTATIONS.length);
    middle = qEuler(r[0] * 20, r[1] * 20, (((rotZ % 360) + 360) % 360) + r[2] * 20);
  }
  return (songTime: number, notePos: Vec3, headPos: Vec3): Quat => {
    const raw = halfJumpDuration ? (songTime - (noteTime - halfJumpDuration)) / (2 * halfJumpDuration) : 0.5;
    const t = Math.max(0, Math.min(0.5, raw));
    const a =
      t < 0.125
        ? qSlerp(Q_ID, middle, Math.sin(t * Math.PI * 4))
        : qSlerp(middle, end, Math.sin((t - 0.125) * Math.PI * 2));
    if (!normal) return a;
    const head: Vec3 = [headPos[0], headPos[1] + (notePos[1] - headPos[1]) * 0.8, headPos[2]];
    const look = qFromAxes(lookAxes(sub(notePos, head), qRot(a, [0, 1, 0])));
    return qNlerp(a, look, t * 2);
  };
}

// ── scoring (sim/scoring.py) ─────────────────────────────────────────────────

// scoring type -> [maxCenter, minPre, maxPre, minPost, maxPost, fixed]
const SCORE_DEFS: readonly (readonly [number, number, number, number, number, number])[] = [
  [15, 0, 70, 0, 30, 0], // 0
  [0, 0, 0, 0, 0, 0], // 1
  [0, 0, 0, 0, 0, 0], // 2
  [15, 0, 70, 0, 30, 0], // 3
  [15, 0, 70, 30, 30, 0], // 4
  [15, 70, 70, 0, 30, 0], // 5
  [15, 0, 70, 0, 0, 0], // 6
  [0, 0, 0, 0, 0, 20], // 7
  [15, 70, 70, 30, 30, 0], // 8
  [15, 70, 70, 30, 30, 0], // 9
  [0, 0, 0, 0, 0, 20], // 10
  [15, 0, 70, 30, 30, 0], // 11
  [15, 70, 70, 30, 30, 0], // 12
];

export function decodeScoringType(noteId: number) {
  return noteId < 100000 ? Math.floor(noteId / 10000) : Math.floor(noteId / 10000000);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function noteScore(before: number, after: number, cutDistance: number, scoringType = 0) {
  const [maxCenter, minPre, maxPre, minPost, maxPost, fixed] = SCORE_DEFS[scoringType] ?? item(SCORE_DEFS, 0);
  const center = roundHalfEven(maxCenter * (1 - clamp01(cutDistance / 0.3)));
  const pre = roundHalfEven(minPre + (maxPre - minPre) * clamp01(before));
  const post = roundHalfEven(minPost + (maxPost - minPost) * clamp01(after));
  return pre + post + center + fixed;
}

export function maxNoteScore(scoringType = 0) {
  const [maxCenter, , maxPre, , maxPost, fixed] = SCORE_DEFS[scoringType] ?? item(SCORE_DEFS, 0);
  return maxCenter + maxPre + maxPost + fixed;
}

// ── resampling (preprocessor.resample_frames) ─────────────────────────────────

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function nlerpQuat(a: Quat, bIn: Quat, t: number): Quat {
  const d = a[0] * bIn[0] + a[1] * bIn[1] + a[2] * bIn[2] + a[3] * bIn[3];
  const b: Quat = d < 0 ? [-bIn[0], -bIn[1], -bIn[2], -bIn[3]] : bIn;
  const q: Quat = [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  return m < 1e-8 ? [0, 0, 0, 1] : [q[0] / m, q[1] / m, q[2] / m, q[3] / m];
}

export function resampleFrames(frames: AiFrame[], rate = SIM_RATE): AiFrame[] {
  if (frames.length < 2) return [...frames];
  const dt = 1 / rate;
  const t1 = item(frames, frames.length - 1).time;
  const out: AiFrame[] = [];
  let j = 0;
  // Accumulated step (not i * dt), matching the Python resampler's time grid.
  for (let t = item(frames, 0).time; t <= t1 + 1e-9; t += dt) {
    while (j + 1 < frames.length - 1 && item(frames, j + 1).time <= t) j++;
    const a = item(frames, j);
    const b = item(frames, j + 1);
    const span = b.time - a.time;
    const f = span <= 1e-9 ? 0 : Math.min(1, Math.max(0, (t - a.time) / span));
    out.push({
      time: t,
      headPos: lerp3(a.headPos, b.headPos, f),
      headRot: nlerpQuat(a.headRot, b.headRot, f),
      leftPos: lerp3(a.leftPos, b.leftPos, f),
      leftRot: nlerpQuat(a.leftRot, b.leftRot, f),
      rightPos: lerp3(a.rightPos, b.rightPos, f),
      rightRot: nlerpQuat(a.rightRot, b.rightRot, f),
    });
  }
  return out;
}

// ── blade movement data (SaberMovementData.AddNewData) ───────────────────────

interface SaberBox {
  center: Vec3;
  axes: Axes;
  half: Vec3;
  radius: number;
}

interface BladeData {
  time: number[];
  top: Vec3[];
  bottom: Vec3[];
  segAngle: number[];
  segNormal: Vec3[];
  /** SaberMovementData.bladeSpeed (smoothed): what the speed check uses */
  speed: number[];
  /** NoteCutter box per frame, null when the three points are in a line */
  box: (SaberBox | null)[];
}

/**
 * GeometryTools.ThreePointsToBox(top, bottom, prevMid): a flat box in the blade's swing plane,
 * the blade's length long, reaching from the blade to prevMid's distance.
 */
function threePointsToBox(p0: Vec3, p1: Vec3, p2: Vec3): SaberBox | null {
  const n = cross(sub(p1, p2), sub(p0, p2));
  if (len(n) <= 1e-5) return null;
  const fwd = norm(sub(p0, p1));
  const v = cross(fwd, norm(n));
  const width = Math.abs(dot(v, sub(p2, p0)));
  const half: Vec3 = [width * 0.5, 0, len(sub(p0, p1)) * 0.5];
  return {
    center: sub(mul(add(p0, p1), 0.5), mul(v, width * 0.5)),
    axes: lookAxes(fwd, norm(n)),
    half,
    radius: Math.hypot(half[0], half[2]),
  };
}

function bladeData(frames: AiFrame[], left: boolean): BladeData {
  const n = frames.length;
  const data: BladeData = {
    time: Array.from({ length: n }, () => 0),
    top: Array.from({ length: n }, (): Vec3 => [0, 0, 0]),
    bottom: Array.from({ length: n }, (): Vec3 => [0, 0, 0]),
    segAngle: Array.from({ length: n }, () => 0),
    segNormal: Array.from({ length: n }, (): Vec3 => [0, 0, 0]),
    speed: Array.from({ length: n }, () => 0),
    box: Array.from({ length: n }, () => null),
  };
  let speed = 0;
  frames.forEach((frame, i) => {
    const pos = left ? frame.leftPos : frame.rightPos;
    const rot = left ? frame.leftRot : frame.rightRot;
    const top = add(pos, quatRotZ(rot, SABER_LENGTH));
    data.time[i] = frame.time;
    data.top[i] = top;
    data.bottom[i] = pos;
    if (i > 0) {
      const prevTop = item(data.top, i - 1);
      const prevBottom = item(data.bottom, i - 1);
      const prevMid = mul(add(prevTop, prevBottom), 0.5);
      data.segAngle[i] = angleDeg(sub(top, pos), sub(prevTop, prevBottom));
      // ComputePlaneNormal(top, bottom, prevTop, prevBottom); Vector3.normalized is zero when tiny
      const normal = cross(sub(top, pos), sub(prevMid, pos));
      data.segNormal[i] = len(normal) > 1e-5 ? norm(normal) : [0, 0, 0];
      // raw tip speed (capped 100) eased in fast (dt*24), out slow (dt*2)
      const dt = frame.time - item(data.time, i - 1);
      if (dt > 1e-4) {
        const raw = Math.min(100, len(sub(top, prevTop)) / dt);
        speed += (raw - speed) * Math.min(1, dt * (raw < speed ? 2 : 24));
      }
      data.speed[i] = speed;
      data.box[i] = threePointsToBox(top, pos, prevMid);
    }
  });
  return data;
}

const bladeVector = (bd: BladeData, i: number) => sub(item(bd.top, i), item(bd.bottom, i));

function boxHitsNote(box: SaberBox, center: Vec3, axes: Axes, half: Vec3, radius: number) {
  const d = sub(center, box.center);
  if (dot(d, d) > (box.radius + radius) ** 2) return false;
  return obbOverlap(box.center, box.axes, box.half, center, axes, half);
}

// ── NoteBasicCutInfoHelper.GetBasicCutInfo ────────────────────────────────────

function basicCutInfo(cutDirVec: Vec3, noteRot: Quat, bladeSpeed: number, color: number, left: boolean, cutDir: number) {
  const local = qRot([-noteRot[0], -noteRot[1], -noteRot[2], noteRot[3]], cutDirVec); // InverseTransformVector
  const stab = Math.abs(local[2]) > Math.abs(local[0]) * 10 && Math.abs(local[2]) > Math.abs(local[1]) * 10;
  const angle = (Math.atan2(local[1], local[0]) * 180) / Math.PI;
  const directionOk = (!stab && -90 - CUT_ANGLE_TOLERANCE < angle && angle < CUT_ANGLE_TOLERANCE - 90) || cutDir === 8;
  let deviation = stab ? 90 : angle + 90;
  if (deviation > 180) deviation -= 360;
  return {
    directionOk,
    speedOk: bladeSpeed > MIN_SABER_SPEED,
    typeOk: (color === 0) === left,
    deviation,
  };
}

// ── swing ratings (SaberMovementData.ComputeSwingRating, SaberSwingRatingCounter) ──

const normalRating = (normalDiffDeg: number) => 1 - Math.max(0, Math.min(1, (normalDiffDeg - 75) / 15));
const beforeStep = (angleDiff: number, normalDiff: number) => (angleDiff * normalRating(normalDiff)) / PRE_FULL_DEG;
const afterStep = (angleDiff: number, normalDiff: number) => (angleDiff * normalRating(normalDiff)) / POST_FULL_DEG;

/** Frame iLast as the newest sample: walk back up to 0.4 s. Unclamped. */
function computeSwingRating(bd: BladeData, iLast: number, overrideAngle: number | null = null) {
  if (iLast < 1) return 0;
  const normalRef = item(bd.segNormal, iLast);
  let rating = beforeStep(overrideAngle ?? item(bd.segAngle, iLast), 0);
  const startT = item(bd.time, iLast);
  let lastT = startT;
  let i = iLast;
  let count = 2;
  while (startT - lastT < SWING_WINDOW_S && count < iLast + 1) {
    i--;
    const nd = angleDeg(item(bd.segNormal, i), normalRef);
    if (nd > 90) break;
    rating += beforeStep(item(bd.segAngle, i), nd);
    lastT = item(bd.time, i);
    count++;
  }
  return rating;
}

/**
 * SaberSwingRatingCounter: Init at the cut frame, then ProcessNewData for it and every later
 * frame. Plane through the note centre with normal cross(cutPlaneNormal, noteForward); when the
 * tip crosses it the before rating is redone from that frame and the 0.4 s window restarts.
 */
function swingRatings(bd: BladeData, iCut: number, notePos: Vec3, noteForward: Vec3): [number, number] {
  const cutNormal = item(bd.segNormal, iCut);
  let cutTime = item(bd.time, iCut);
  let before = computeSwingRating(bd, iCut);
  let after = 0;
  let planeWasCut = false;
  const planeN = cross(cutNormal, noteForward);
  const planeD = -dot(planeN, notePos);
  const above = (p: Vec3) => dot(planeN, p) + planeD > 0;

  for (let j = iCut; j < bd.time.length; j++) {
    if (item(bd.time, j) - cutTime > SWING_WINDOW_S) break;
    if (planeWasCut && after >= 1) break;
    if (j < 1) continue;
    const top = item(bd.top, j);
    const prevTop = item(bd.top, j - 1);
    if (!planeWasCut && above(top) !== above(prevTop)) {
      const seg = sub(top, prevTop);
      const denom = dot(planeN, seg);
      const f = Math.abs(denom) < 1e-12 ? 0 : -(dot(planeN, prevTop) + planeD) / denom;
      const cutTop = add(prevTop, mul(seg, f));
      const cutBottom = mul(add(item(bd.bottom, j - 1), item(bd.bottom, j)), 0.5);
      const cutBlade = sub(cutTop, cutBottom);
      cutTime = item(bd.time, j);
      before = computeSwingRating(bd, j, angleDeg(cutBlade, bladeVector(bd, j - 1)));
      after = Math.min(1, afterStep(angleDeg(cutBlade, bladeVector(bd, j)), 0));
      planeWasCut = true;
    } else {
      const nd = angleDeg(item(bd.segNormal, j), cutNormal);
      if (nd > 90) break;
      after = Math.min(1, after + afterStep(item(bd.segAngle, j), nd));
    }
  }
  return [Math.min(1, before), after];
}

// ── main entry (simulate_notes) ───────────────────────────────────────────────

/**
 * frames: uniform SIM_RATE world-space frames. One result per note.
 * halfJumpDuration: the map's half jump (s); drives the note's turn and when its colliders switch
 * on. null = every frame uses the arrival rotation, with only the CUT_WINDOW_S lower bound.
 */
export function simulateNotes(
  frames: AiFrame[],
  notes: SimNote[],
  njs: number,
  zAtArrival = SWORD_OFFSET,
  halfJumpDuration: number | null = null,
) {
  const results: SimCutResult[] = [];
  if (frames.length === 0) return results;
  const t0 = item(frames, 0).time;
  const dtFrame = frames.length > 1 ? item(frames, 1).time - t0 : 1 / SIM_RATE;
  const blades = { left: bladeData(frames, true), right: bladeData(frames, false) };
  const bombAxes = qAxes(Q_ID);

  for (const note of notes) {
    const base = note.noteId % 10000;
    const lineIndex = Math.floor(base / 1000) % 10;
    const lineLayer = Math.floor(base / 100) % 10;
    const color = Math.floor(base / 10) % 10;
    const cutDir = base % 10;
    const isBomb = color > 1;
    const scoringType = decodeScoringType(note.noteId);
    const position = noteMotion(lineIndex, lineLayer, note.time, njs, zAtArrival);
    const rotationAt = noteRotation(
      (ROTATION_ANGLE[cutDir] ?? 0) + (note.angleOffset ?? 0),
      note.time,
      halfJumpDuration,
      gridX(lineIndex),
      gridY(lineLayer),
      !CHAIN_HEAD_TYPES.has(scoringType),
    );
    const empty = {
      noteId: note.noteId,
      spawnTime: note.time,
      cutTime: null,
      saberType: 0,
      saberSpeed: 0,
      directionOk: false,
      cutDirDeviation: 0,
      cutDistanceToCenter: 0,
      timeDeviation: 0,
      beforeCutRating: 0,
      afterCutRating: 0,
      score: 0,
    };

    // Collider lifetime. Notes: jump start → missed marker (noteTime + 0.15 s). Bombs: until arrival.
    let tFirst = note.time - CUT_WINDOW_S;
    if (halfJumpDuration && !isBomb) tFirst = Math.max(tFirst, note.time - halfJumpDuration);
    const tLast = isBomb ? note.time : note.time + MISSED_TIME_OFFSET;
    const iLo = Math.max(1, Math.floor((tFirst - t0) / dtFrame));
    const iHi = Math.min(frames.length - 1, Math.ceil((tLast - t0) / dtFrame));
    const iArrive = Math.max(0, Math.min(frames.length - 1, Math.round((note.time - t0) / dtFrame)));

    // GameNoteController.HandleCut: big collider fires only for a fully OK cut, small collider
    // always. First registration wins: a bad cut is final.
    type Hit = { i: number; left: boolean; info: ReturnType<typeof basicCutInfo> | null; rot: Quat };
    let hit: Hit | null = null;
    for (let i = iLo; i <= iHi && hit === null; i++) {
      const ft = item(frames, i).time;
      if (ft < tFirst || (isBomb ? ft >= tLast : ft > tLast)) continue;
      const center = position(ft);
      if (Math.abs(center[2]) > 3) continue;
      let rot: Quat | null = null;
      let axes: Axes | null = null;
      for (const left of [true, false]) {
        const bd = left ? blades.left : blades.right;
        const box = item(bd.box, i);
        if (box === null) continue;
        if (isBomb) {
          if (boxHitsNote(box, center, bombAxes, SMALL_HALF, BIG_RADIUS)) {
            hit = { i, left, info: null, rot: Q_ID };
            break;
          }
          continue;
        }
        if (rot === null || axes === null) {
          const tRot = Math.min(ft, note.time);
          rot = rotationAt(tRot, position(tRot), item(frames, ft <= note.time ? i : iArrive).headPos);
          axes = qAxes(rot);
        }
        if (!boxHitsNote(box, center, axes, BIG_HALF, BIG_RADIUS)) continue;
        const info = basicCutInfo(sub(item(bd.top, i), item(bd.top, i - 1)), rot, item(bd.speed, i), color, left, cutDir);
        if ((info.directionOk && info.speedOk && info.typeOk) || boxHitsNote(box, center, axes, SMALL_HALF, BIG_RADIUS)) {
          hit = { i, left, info, rot };
          break;
        }
      }
    }

    if (hit === null) {
      results.push({ ...empty, eventType: isBomb ? 4 : 2 });
      continue;
    }
    const { i, left, info, rot } = hit;
    const bd = left ? blades.left : blades.right;
    if (isBomb || info === null) {
      results.push({
        ...empty,
        eventType: 3,
        cutTime: item(bd.time, i),
        saberType: left ? 0 : 1,
        saberSpeed: item(bd.speed, i),
      });
      continue;
    }

    const center = position(item(bd.time, i));
    // cut plane through (top, bottom, prev blade mid) - GameNoteController
    const prevMid = mul(add(item(bd.top, i - 1), item(bd.bottom, i - 1)), 0.5);
    const planeNormal = norm(cross(sub(item(bd.bottom, i), item(bd.top, i)), sub(prevMid, item(bd.top, i))));
    const cutDistance = Math.abs(dot(sub(center, item(bd.top, i)), planeNormal));
    const good = info.directionOk && info.speedOk && info.typeOk;
    const [before, after] = good ? swingRatings(bd, i, center, qRot(rot, [0, 0, 1])) : [0, 0];
    results.push({
      noteId: note.noteId,
      spawnTime: note.time,
      eventType: good ? 0 : 1,
      cutTime: item(bd.time, i),
      saberType: left ? 0 : 1,
      saberSpeed: item(bd.speed, i),
      directionOk: info.directionOk,
      cutDirDeviation: info.deviation,
      cutDistanceToCenter: cutDistance,
      timeDeviation: item(bd.time, i) - note.time,
      beforeCutRating: before,
      afterCutRating: after,
      score: good ? noteScore(before, after, cutDistance, scoringType) : 0,
    });
  }
  return results;
}
