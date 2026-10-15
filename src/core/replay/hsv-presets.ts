import mosProfile from './hsv-presets/mos.json?raw';

/** HitScoreVisualizer profiles bundled with the viewer, picked with `?hsv=<id>`. */
export const hsvPresetIds = ['mos'] as const;

export type HsvPresetId = (typeof hsvPresetIds)[number];

export const hsvPresets: Record<HsvPresetId, string> = {
  mos: mosProfile,
};
