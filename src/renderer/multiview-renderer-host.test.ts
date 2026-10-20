import { describe, expect, test } from 'vite-plus/test';

import { multiviewFrameRate } from './multiview-renderer-host';
import { DEFAULT_RENDER_PERFORMANCE } from './render-performance';

describe('multiview frame rate', () => {
  test('uses the lowest visible player cap', () => {
    const entry = (maxFps: number) => ({ performance: { ...DEFAULT_RENDER_PERFORMANCE, maxFps } });
    expect(multiviewFrameRate([entry(60), entry(45), entry(30)])).toBe(30);
    expect(multiviewFrameRate([])).toBe(1);
  });
});
