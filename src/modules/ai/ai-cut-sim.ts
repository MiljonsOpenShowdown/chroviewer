// Saber/note cut simulation for AI play. Port of MOSes's
// pTrainer/sim/{cut_sim,note_motion,scoring}.py and preprocessor.resample_frames,
// which reproduce the game's cut pipeline (validated against real replays).
// Keep in step with those files.

import type { Quat } from './ai-features';
import type { AiFrame } from './ai-generate';
import { item } from './ai-util';

type Vec3 = [number, number, number];

const SABER_LENGTH = 1;
const MIN_SABER_SPEED = 2;
const CUT_ANGLE_TOLERANCE = 60;
const PRE_FULL_DEG = 100;
const POST_FULL_DEG = 60;
export const SWING_WINDOW_S = 0.4;
export const CUT_WINDOW_S = 0.45;
export const SWORD_OFFSET = 0.9;
export const SIM_RATE = 90;
const BIG_HALF: Vec3 = [0.4, 0.3, 0.5];
const SMALL_HALF: Vec3 = [0.175, 0.175, 0.175];
const ROTATION_ANGLE: Record<number, number> = { 0: 180, 1: 0, 2: 270, 3: 90, 4: 225, 5: 135, 6: 315, 7: 45 };

/** Map note for the sim: noteId = line*1000 + layer*100 + color*10 + direction (color 3 = bomb). */
export interface SimNote {
  noteId: number;
  time: number;
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
function rotZ2d(v: Vec3, deg: number): Vec3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
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

/** Python's round(): half to even. */
function roundHalfEven(value: number) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
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

// ── blade movement data ───────────────────────────────────────────────────────

interface BladeData {
  time: number[];
  top: Vec3[];
  bottom: Vec3[];
  segAngle: number[];
  segNormal: Vec3[];
  speed: number[];
}

function bladeData(frames: AiFrame[], left: boolean): BladeData {
  const n = frames.length;
  const data: BladeData = {
    time: Array.from({ length: n }, () => 0),
    top: Array.from({ length: n }, (): Vec3 => [0, 0, 0]),
    bottom: Array.from({ length: n }, (): Vec3 => [0, 0, 0]),
    segAngle: Array.from({ length: n }, () => 0),
    segNormal: Array.from({ length: n }, (): Vec3 => [0, 0, 1]),
    speed: Array.from({ length: n }, () => 0),
  };
  frames.forEach((frame, i) => {
    const pos = left ? frame.leftPos : frame.rightPos;
    const rot = left ? frame.leftRot : frame.rightRot;
    const top = add(pos, quatRotZ(rot, SABER_LENGTH));
    data.time[i] = frame.time;
    data.top[i] = top;
    data.bottom[i] = pos;
    if (i > 0) {
      const blade = sub(top, pos);
      const bladePrev = sub(item(data.top, i - 1), item(data.bottom, i - 1));
      const motion = sub(top, item(data.top, i - 1));
      data.segAngle[i] = angleDeg(blade, bladePrev);
      data.segNormal[i] = norm(cross(norm(blade), norm(motion)));
      data.speed[i] = len(motion) / Math.max(frame.time - item(data.time, i - 1), 1e-4);
    }
  });
  return data;
}

const bladeVector = (bd: BladeData, i: number) => sub(item(bd.top, i), item(bd.bottom, i));

// ── contact + cut info ────────────────────────────────────────────────────────

function segmentHitsBox(p0: Vec3, p1: Vec3, center: Vec3, half: Vec3) {
  const d = sub(p1, p0);
  const o = sub(p0, center);
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(item(d, i)) < 1e-9) {
      if (Math.abs(item(o, i)) > item(half, i)) return false;
    } else {
      const inv = 1 / item(d, i);
      let a = (-item(half, i) - item(o, i)) * inv;
      let b = (item(half, i) - item(o, i)) * inv;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function sweptBladeHitsBox(bd: BladeData, i: number, center: Vec3, half: Vec3) {
  if (segmentHitsBox(item(bd.bottom, i), item(bd.top, i), center, half)) return true;
  if (i > 0) {
    if (segmentHitsBox(item(bd.top, i - 1), item(bd.top, i), center, half)) return true;
    const prevMid = mul(add(item(bd.top, i - 1), item(bd.bottom, i - 1)), 0.5);
    const curMid = mul(add(item(bd.top, i), item(bd.bottom, i)), 0.5);
    if (segmentHitsBox(prevMid, curMid, center, half)) return true;
  }
  return false;
}

function basicCutInfo(cutDirVec: Vec3, cutDir: number, bladeSpeed: number, color: number, left: boolean) {
  const local = rotZ2d(cutDirVec, -(ROTATION_ANGLE[cutDir] ?? 0));
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

// ── swing ratings ─────────────────────────────────────────────────────────────

const normalRating = (normalDiffDeg: number) => 1 - Math.max(0, Math.min(1, (normalDiffDeg - 75) / 15));
const beforeStep = (angleDiff: number, normalDiff: number) => (angleDiff * normalRating(normalDiff)) / PRE_FULL_DEG;
const afterStep = (angleDiff: number, normalDiff: number) => (angleDiff * normalRating(normalDiff)) / POST_FULL_DEG;

function computeSwingRating(bd: BladeData, iCut: number) {
  const normalCut = item(bd.segNormal, iCut);
  let rating = beforeStep(item(bd.segAngle, iCut), 0);
  const startT = item(bd.time, iCut);
  for (let i = iCut - 1; i > 0 && startT - item(bd.time, i) < SWING_WINDOW_S; i--) {
    const nd = angleDeg(item(bd.segNormal, i), normalCut);
    if (nd > 90) break;
    rating += beforeStep(item(bd.segAngle, i), nd);
  }
  return rating;
}

function swingRatings(bd: BladeData, iCut: number, notePos: Vec3, noteRotDeg: number): [number, number] {
  const cutPlaneNormal = item(bd.segNormal, iCut);
  const planeN = rotZ2d([0, 1, 0], noteRotDeg);
  const planeD = -dot(planeN, notePos);
  const side = (p: Vec3) => dot(planeN, p) + planeD;

  let before = computeSwingRating(bd, iCut);
  let after = 0;
  let planeWasCut = false;
  const cutBlade = bladeVector(bd, iCut);
  const tCut = item(bd.time, iCut);
  for (let i = iCut + 1; i < bd.time.length && item(bd.time, i) - tCut <= SWING_WINDOW_S; i++) {
    const nd = angleDeg(item(bd.segNormal, i), cutPlaneNormal);
    if (!planeWasCut && side(item(bd.top, i)) * side(item(bd.top, i - 1)) < 0) {
      after += afterStep(angleDeg(cutBlade, bladeVector(bd, i)), 0);
      planeWasCut = true;
    } else {
      if (!planeWasCut && nd <= 90) before += beforeStep(item(bd.segAngle, i), nd);
      after += afterStep(item(bd.segAngle, i), nd);
    }
  }
  return [Math.min(1, before), Math.min(1, after)];
}

// ── main entry (simulate_notes) ───────────────────────────────────────────────

/** frames: uniform SIM_RATE world-space frames. One result per note. */
export function simulateNotes(frames: AiFrame[], notes: SimNote[], njs: number, zAtArrival = SWORD_OFFSET) {
  const results: SimCutResult[] = [];
  if (frames.length === 0) return results;
  const dtFrame = frames.length > 1 ? item(frames, 1).time - item(frames, 0).time : 1 / SIM_RATE;
  const blades = { left: bladeData(frames, true), right: bladeData(frames, false) };

  for (const note of notes) {
    const base = note.noteId % 10000;
    const lineIndex = Math.floor(base / 1000) % 10;
    const lineLayer = Math.floor(base / 100) % 10;
    const color = Math.floor(base / 10) % 10;
    const cutDir = base % 10;
    const isBomb = color > 1;
    const position = noteMotion(lineIndex, lineLayer, note.time, njs, zAtArrival);
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

    const iLo = Math.max(1, Math.trunc((note.time - CUT_WINDOW_S - item(frames, 0).time) / dtFrame));
    const iHi = Math.min(frames.length - 1, Math.trunc((note.time + CUT_WINDOW_S - item(frames, 0).time) / dtFrame));
    type Hit = { i: number; left: boolean; info: ReturnType<typeof basicCutInfo> };
    let hit: Hit | null = null;
    let badHit: Hit | null = null;
    for (let i = iLo; i <= iHi; i++) {
      const center = position(item(frames, i).time);
      if (Math.abs(center[2]) > 3) continue;
      for (const left of [true, false]) {
        const bd = left ? blades.left : blades.right;
        if (!sweptBladeHitsBox(bd, i, center, BIG_HALF)) continue;
        const info = basicCutInfo(sub(item(bd.top, i), item(bd.top, i - 1)), cutDir, item(bd.speed, i), color, left);
        if (isBomb) {
          if (sweptBladeHitsBox(bd, i, center, SMALL_HALF)) hit = { i, left, info };
          continue;
        }
        if (info.directionOk && info.speedOk && info.typeOk) {
          hit = { i, left, info };
          break;
        } else if (badHit === null && sweptBladeHitsBox(bd, i, center, SMALL_HALF)) {
          badHit = { i, left, info };
        }
      }
      if (hit !== null) break;
    }
    hit ??= badHit;

    if (hit === null) {
      results.push({ ...empty, eventType: isBomb ? 4 : 2 });
      continue;
    }
    const { i, left, info } = hit;
    const bd = left ? blades.left : blades.right;
    if (isBomb) {
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
    const prevMid = mul(add(item(bd.top, i - 1), item(bd.bottom, i - 1)), 0.5);
    const planeNormal = norm(cross(sub(item(bd.bottom, i), item(bd.top, i)), sub(prevMid, item(bd.top, i))));
    const cutDistance = Math.abs(dot(sub(center, item(bd.top, i)), planeNormal));
    const good = info.directionOk && info.speedOk && info.typeOk;
    const [before, after] = good ? swingRatings(bd, i, center, ROTATION_ANGLE[cutDir] ?? 0) : [0, 0];
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
      score: good ? noteScore(before, after, cutDistance, decodeScoringType(note.noteId)) : 0,
    });
  }
  return results;
}
