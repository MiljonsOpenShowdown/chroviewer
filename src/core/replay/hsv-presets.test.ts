import { describe, expect, it } from 'vite-plus/test';

import { parseHitScoreVisualizerProfile } from './hit-score-visualizer-profile';
import { hsvPresetIds, hsvPresets } from './hsv-presets';

describe('hsvPresets', () => {
  it.each(hsvPresetIds)('%s is a valid profile', (id) => {
    expect(parseHitScoreVisualizerProfile(hsvPresets[id]).isOk()).toBe(true);
  });
});
