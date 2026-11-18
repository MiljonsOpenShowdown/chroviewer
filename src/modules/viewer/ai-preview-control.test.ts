import { describe, expect, test } from 'vite-plus/test';

import { aiParentControlStep, type AiParentControl } from './ai-preview-control';

const LEAD = 3;
const idle = { seek: null, play: false, pause: false };

describe('AI preview driven by the parent', () => {
  test('never plays before the parent asks', () => {
    const control: AiParentControl = { armed: false, target: null };
    expect(aiParentControlStep(control, 60, 0, false, LEAD)).toEqual(idle);
  });

  test('a seek inside the generated play applies at once and stays paused', () => {
    const control: AiParentControl = { armed: false, target: 40 };
    expect(aiParentControlStep(control, 60, 0, false, LEAD)).toEqual({ ...idle, seek: 40 });
    expect(control.target).toBeNull();
    expect(aiParentControlStep(control, 61, 40, false, LEAD)).toEqual(idle);
  });

  test('a seek past the generated play waits for the AI to get there', () => {
    const control: AiParentControl = { armed: false, target: 55 };
    expect(aiParentControlStep(control, 30, 0, false, LEAD)).toEqual(idle);
    expect(control.target).toBe(55);
    expect(aiParentControlStep(control, 55, 0, false, LEAD)).toEqual({ ...idle, seek: 55 });
    expect(control.target).toBeNull();
  });

  test('play is armed until the lead is generated, then starts from the sought time', () => {
    const control: AiParentControl = { armed: true, target: 55 };
    // Still generating up to the target: nothing yet
    expect(aiParentControlStep(control, 50, 0, false, LEAD)).toEqual(idle);
    // At the target, but less than the lead ahead: seek only
    expect(aiParentControlStep(control, 56, 0, false, LEAD)).toEqual({ ...idle, seek: 55 });
    expect(aiParentControlStep(control, 57.9, 55, false, LEAD)).toEqual(idle);
    expect(aiParentControlStep(control, 58, 55, false, LEAD)).toEqual({ ...idle, play: true });
  });

  test('a seek with the lead already generated plays at once when armed', () => {
    const control: AiParentControl = { armed: true, target: 10 };
    expect(aiParentControlStep(control, 60, 0, false, LEAD)).toEqual({ ...idle, seek: 10, play: true });
  });

  test('pauses at the generation edge and resumes once the lead is back', () => {
    const control: AiParentControl = { armed: true, target: null };
    expect(aiParentControlStep(control, 20, 19, true, LEAD)).toEqual(idle);
    expect(aiParentControlStep(control, 20, 20, true, LEAD)).toEqual({ ...idle, pause: true });
    expect(aiParentControlStep(control, 22, 20, false, LEAD)).toEqual(idle);
    expect(aiParentControlStep(control, 23, 20, false, LEAD)).toEqual({ ...idle, play: true });
  });

  test('a finished AI plays to the end', () => {
    const control: AiParentControl = { armed: true, target: null };
    expect(aiParentControlStep(control, Number.POSITIVE_INFINITY, 200, true, LEAD)).toEqual(idle);
  });

  test('a seek past the edge while playing pauses until it is reached', () => {
    const control: AiParentControl = { armed: true, target: 90 };
    expect(aiParentControlStep(control, 40, 30, true, LEAD)).toEqual({ ...idle, pause: true });
    expect(control.armed).toBe(true);
  });

  test('disarmed playback is paused', () => {
    const control: AiParentControl = { armed: false, target: null };
    expect(aiParentControlStep(control, 60, 10, true, LEAD)).toEqual({ ...idle, pause: true });
  });
});
