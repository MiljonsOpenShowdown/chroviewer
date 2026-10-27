import { expect, test } from 'vite-plus/test';

import { DEFAULT_COLORS } from '../colors';
import {
  glsColorSettledUntil,
  glsTweenSettledUntil,
  sampleGlsColorTween,
  sampleGlsFloat,
  sampleGlsRotationTween,
  type GlsColorTweenEvent,
  type GlsRotationTweenEvent,
} from './gls-sampling';

/** Deterministic pseudo random numbers. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Mostly steps, some eased, some reusing the previous event, at uneven times
function times(next: () => number, count: number) {
  let time = 1;
  return Array.from({ length: count }, () => (time += 0.25 + Math.floor(next() * 8) * 0.25));
}
const easing = (next: () => number) => (next() < 0.6 ? -1 : Math.floor(next() * 4));

function rotations(seed: number): GlsRotationTweenEvent[] {
  const next = random(seed);
  return times(next, 60).map((time) => ({
    time,
    value: Math.floor(next() * 8) * 45 - 180,
    easing: easing(next),
    usePrevious: next() < 0.2 ? 1 : 0,
    loop: Math.floor(next() * 2),
    direction: Math.floor(next() * 3),
  }));
}

function colors(seed: number): GlsColorTweenEvent[] {
  const next = random(seed);
  return times(next, 60).map((time) => ({
    time,
    color: Math.floor(next() * 3),
    brightness: next(),
    easing: easing(next),
    usePrevious: next() < 0.2 ? 1 : 0,
    frequency: next() < 0.2 ? 2 + Math.floor(next() * 6) : 0,
    strobeBrightness: next(),
    strobeFade: next() < 0.5 ? 1 : 0,
  }));
}

/** Every beat in [from, until) the sampler is asked for must give exactly what it gave at `from`. */
function expectSettled<T>(sample: (time: number) => T, settledUntil: (time: number) => number, end: number) {
  let settled = 0;
  for (let from = 0; from < end; from += 0.05) {
    const until = settledUntil(from);
    if (!(until > from)) continue;
    settled++;
    const expected = sample(from);
    for (let time = from; time < Math.min(until, end); time += 0.03) {
      expect(sample(time), `from ${from} at ${time}`).toStrictEqual(expected);
    }
    // Just short of the end too, where a step could round up
    if (Number.isFinite(until)) expect(sample(until - 1e-9), `from ${from} before ${until}`).toStrictEqual(expected);
  }
  return settled;
}

test('rotations and translations hold while glsTweenSettledUntil says so', () => {
  for (const seed of [1, 2, 3]) {
    const events = rotations(seed);
    const end = (events.at(-1)?.time ?? 0) + 4;
    const rotation = expectSettled(
      (time) => sampleGlsRotationTween(events, time),
      (time) => glsTweenSettledUntil(events, time, true),
      end,
    );
    const float = expectSettled(
      (time) => sampleGlsFloat(events, time),
      (time) => glsTweenSettledUntil(events, time, false),
      end,
    );
    // Most beats are settled: the check above is not vacuous
    expect(rotation).toBeGreaterThan(end * 10);
    expect(float).toBeGreaterThan(end * 10);
  }
}, 30_000);

test('colors hold while glsColorSettledUntil says so', () => {
  for (const seed of [1, 2, 3]) {
    const states = colors(seed);
    const end = (states.at(-1)?.time ?? 0) + 4;
    const settled = expectSettled(
      (time) => sampleGlsColorTween(states, time, DEFAULT_COLORS, false),
      (time) => glsColorSettledUntil(states, time),
      end,
    );
    expect(settled).toBeGreaterThan(end * 5);
  }
}, 30_000);
