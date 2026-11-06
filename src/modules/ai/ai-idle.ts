// Procedural idle in long note-free breaks and after the generated motion ends
// (last note + 2 s), so the head and sabers neither drift off nor freeze until
// the song's audio ends. Idle holds the model's own pose at the moment it
// begins and adds slow deterministic sine wobble; the wobble is relative
// (wobble(t) - wobble(anchor time)), so it never pulls the sabers into a
// different stance. Port of pTrainer/sim/idle_pose.py and
// DataPuller/AI/IdlePose.cs — keep the constants in sync.

import { quaternionFromEuler } from '../../core/animation/point-definition';
import type { Quat } from './ai-features';
import type { AiFrame } from './ai-generate';

type Vec3 = [number, number, number];
type Wobble = [Vec3, Quat];

const FPS = 60;
const BLEND_S = 1.0;
const TAU = Math.PI * 2;

const wave = (t: number, amp: number, f1: number, p1: number, f2: number, p2: number) =>
  amp * (0.6 * Math.sin(TAU * f1 * t + p1) + 0.4 * Math.sin(TAU * f2 * t + p2));

function mul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const inv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

const lerp3 = (a: Vec3, b: Vec3, w: number): Vec3 => [
  a[0] + (b[0] - a[0]) * w,
  a[1] + (b[1] - a[1]) * w,
  a[2] + (b[2] - a[2]) * w,
];

function nlerp(a: Quat, b: Quat, w: number): Quat {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q: Quat = [
    a[0] + (s * b[0] - a[0]) * w,
    a[1] + (s * b[1] - a[1]) * w,
    a[2] + (s * b[2] - a[2]) * w,
    a[3] + (s * b[3] - a[3]) * w,
  ];
  const len = Math.hypot(...q) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

const euler = (x: number, y: number, z: number) => quaternionFromEuler([x, y, z]) as Quat;

// phase offsets left vs right so the hands never move in lockstep
const hand = (t: number, phase: number): Wobble => [
  [
    wave(t, 0.02, 0.11, phase, 0.17, phase + 1.0),
    wave(t, 0.015, 0.13, phase + 0.5, 0.22, phase + 2.0),
    wave(t, 0.015, 0.19, phase + 1.5, 0.09, phase + 0.3),
  ],
  euler(
    wave(t, 5, 0.09, phase, 0.15, phase + 2.5),
    wave(t, 3, 0.07, phase + 1.2, 0.13, phase),
    wave(t, 5, 0.12, phase + 0.7, 0.06, phase + 1.9),
  ),
];

const wobble = (t: number): [Wobble, Wobble, Wobble] => [
  [
    [
      wave(t, 0.008, 0.05, 0.4, 0.083, 2.1),
      wave(t, 0.01, 0.22, 0.0, 0.37, 1.3), // breathing
      wave(t, 0.006, 0.061, 1.7, 0.097, 0.2),
    ],
    euler(wave(t, 2.5, 0.07, 0.9, 0.113, 2.6), wave(t, 4, 0.05, 0.0, 0.089, 1.1), wave(t, 1, 0.043, 2.2, 0.071, 0.5)),
  ],
  hand(t, 0),
  hand(t, 2.4),
];

function shift(pos: Vec3, rot: Quat, [dp0, r0]: Wobble, [dp1, r1]: Wobble): [Vec3, Quat] {
  return [[pos[0] + dp1[0] - dp0[0], pos[1] + dp1[1] - dp0[1], pos[2] + dp1[2] - dp0[2]], mul(mul(rot, inv(r0)), r1)];
}

/** Idle pose at `t`, held around `anchor` (its pose at anchor.time). */
function drift(anchor: AiFrame, t: number): AiFrame {
  const [h0, l0, r0] = wobble(anchor.time);
  const [h1, l1, r1] = wobble(t);
  const [headPos, headRot] = shift(anchor.headPos, anchor.headRot, h0, h1);
  const [leftPos, leftRot] = shift(anchor.leftPos, anchor.leftRot, l0, l1);
  const [rightPos, rightRot] = shift(anchor.rightPos, anchor.rightRot, r0, r1);
  return { time: t, headPos, headRot, leftPos, leftRot, rightPos, rightRot };
}

/** 60 Hz idle frames after `last` up to `until`, held around the last pose. */
export function idleFrames(last: AiFrame, until: number): AiFrame[] {
  const frames: AiFrame[] = [];
  for (let i = 1; last.time + i / FPS <= until; i++) frames.push(drift(last, last.time + i / FPS));
  return frames;
}

// Mid-map breaks (sim/idle_pose.py GapIdle): inside each stretch with no notes,
// bombs or walls the motion blends into idle held around the model's pose at
// the break's start, and back into the model before the next event, so nothing
// that scores is touched. After the last event it stays idle to the end so
// idleFrames continues it.
const GAP_AFTER_S = 0.75;
const GAP_BEFORE_S = 1.0;
const GAP_MIN_HOLD_S = 1.0;

/** Stateful per map: call with each batch of generated frames in song order. */
export function gapIdle(eventTimes: number[], walls: [start: number, duration: number][]) {
  const busy: [number, number][] = [];
  const spans = [
    ...eventTimes.map((t): [number, number] => [t, t]),
    ...walls.map(([s, d]): [number, number] => [s, s + Math.max(0, d)]),
  ].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of spans) {
    const top = busy[busy.length - 1];
    if (top !== undefined && start <= top[1]) top[1] = Math.max(top[1], end);
    else busy.push([start, end]);
  }
  let windows: [number, number][] | null = null;
  const anchors = new Map<number, AiFrame>();

  return (frames: AiFrame[]): AiFrame[] => {
    const first = frames[0];
    if (first === undefined) return frames;
    if (windows === null) {
      const starts = [first.time, ...busy.map(([, end]) => end + GAP_AFTER_S)];
      const ends = [...busy.map(([start]) => start - GAP_BEFORE_S), Infinity];
      windows = starts
        .map((a, i): [number, number] => [a, ends[i] ?? Infinity])
        .filter(([a, b]) => b === Infinity || b - a >= 2 * BLEND_S + GAP_MIN_HOLD_S);
    }
    const list = windows;
    return frames.map((frame) => {
      const k = list.findIndex(([a, b]) => frame.time >= a && frame.time <= b);
      const window = list[k];
      if (window === undefined) return frame;
      const [a, b] = window;
      // the model's own pose as the idle begins
      const anchor = anchors.get(k) ?? frame;
      anchors.set(k, anchor);
      const w = smooth((frame.time - a) / BLEND_S) * (b === Infinity ? 1 : smooth((b - frame.time) / BLEND_S));
      if (w <= 0) return frame;
      const d = drift(anchor, frame.time);
      return {
        time: frame.time,
        headPos: lerp3(frame.headPos, d.headPos, w),
        headRot: nlerp(frame.headRot, d.headRot, w),
        leftPos: lerp3(frame.leftPos, d.leftPos, w),
        leftRot: nlerp(frame.leftRot, d.leftRot, w),
        rightPos: lerp3(frame.rightPos, d.rightPos, w),
        rightRot: nlerp(frame.rightRot, d.rightRot, w),
      };
    });
  };
}
