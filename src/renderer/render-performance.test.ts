import { expect, test } from 'vite-plus/test';

import { broadcastSettingsForPlayerCount } from './render-performance';

test('broadcast budgets scale up to eight POVs while maintaining a 60 FPS output cadence', () => {
  for (const count of [1, 2, 3, 4, 6, 8]) {
    const settings = broadcastSettingsForPlayerCount(count);
    expect(settings.maxFps).toBe(60);
    expect(settings.mirrorResolution).toBe(0);
    expect(settings.screenDisplacement).toBe(false);
  }
  expect(broadcastSettingsForPlayerCount(8)).toMatchObject({
    renderScale: 0.65,
    msaaSamples: 0,
    postBloomWidth: 384,
    bloomFogSize: 128,
    replayTrailSamples: 8,
  });
});
