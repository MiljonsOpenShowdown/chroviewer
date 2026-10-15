import { describe, expect, test } from 'vite-plus/test';

import type { InfoColorScheme } from './beatmap/info';
import { DEFAULT_COLORS, resolveColorScheme, type EnvironmentColorScheme } from './colors';
import type { ReplayColor, ReplayMetadata } from './replay/types';
import { settingsForShareCategories } from './share-link';
import {
  colorOverride,
  DEFAULT_VIEWER_SETTINGS,
  environmentForSettings,
  hexToRgb,
  loadViewerSettings,
  viewerSettingsPatchSchema,
} from './viewer-settings';

const recordedColor = (x: number): ReplayColor => ({ x, y: 0.1, z: 0.2, a: 1 });
const metadata = (index = 1): ReplayMetadata => ({
  version: '1',
  levelId: 'map',
  difficulty: 9,
  characteristic: 'Standard',
  environment: 'PlayerEnvironment',
  modifiers: [],
  noteSpawnOffset: 0,
  leftHanded: false,
  initialHeight: 1.7,
  roomRotation: 0,
  roomCenter: { x: 0, y: 0, z: 0 },
  failTime: 0,
  hasPlaySettings: true,
  supportsEnvironmentColorBoost: true,
  leftSaberColor: recordedColor(index / 8),
  rightSaberColor: recordedColor(0.9),
  environmentColor0: recordedColor(0.3),
  environmentColor1: recordedColor(0.4),
  environmentColorW: recordedColor(0.5),
  environmentColor0Boost: recordedColor(0.6),
  environmentColor1Boost: recordedColor(0.7),
  environmentColorWBoost: recordedColor(0.8),
});
const environment: EnvironmentColorScheme = {
  colorLeft: DEFAULT_COLORS.leftNote,
  colorRight: DEFAULT_COLORS.rightNote,
  obstacleColor: DEFAULT_COLORS.obstacle,
  envColorLeft: DEFAULT_COLORS.environmentLeft,
  envColorRight: DEFAULT_COLORS.environmentRight,
  envColorWhite: DEFAULT_COLORS.environmentWhite,
  envColorLeftBoost: DEFAULT_COLORS.environmentLeftBoost,
  envColorRightBoost: DEFAULT_COLORS.environmentRightBoost,
  envColorWhiteBoost: DEFAULT_COLORS.environmentWhiteBoost,
  supportsEnvironmentColorBoost: true,
};
const map: InfoColorScheme = {
  ...DEFAULT_COLORS,
  name: 'Map palette',
  overrideNotes: true,
  overrideLights: true,
  supportsEnvironmentColorBoost: true,
  customColors: { leftNote: [0.2, 0.5, 0.7], environmentWhite: [0.1, 0.2, 0.3] },
};

describe('independent player cosmetics', () => {
  test('all six environment overrides win over replay and legacy map colors while eight players retain saber colors', () => {
    const settings = {
      ...DEFAULT_VIEWER_SETTINGS,
      customEnvironmentColors: true,
      environmentLeftColor: '#010203',
      environmentRightColor: '#040506',
      environmentWhiteColor: '#070809',
      environmentLeftBoostColor: '#0a0b0c',
      environmentRightBoostColor: '#0d0e0f',
      environmentWhiteBoostColor: '#101112',
    };
    for (let index = 0; index < 8; index++) {
      const colors = resolveColorScheme(environment, colorOverride(settings, map, metadata(index)));
      expect(colors.leftNote).toEqual([index / 8, 0.1, 0.2]);
      expect(colors.environmentLeft).toEqual(hexToRgb('#010203'));
      expect(colors.environmentRight).toEqual(hexToRgb('#040506'));
      expect(colors.environmentWhite).toEqual(hexToRgb('#070809'));
      expect(colors.environmentLeftBoost).toEqual(hexToRgb('#0a0b0c'));
      expect(colors.environmentRightBoost).toEqual(hexToRgb('#0d0e0f'));
      expect(colors.environmentWhiteBoost).toEqual(hexToRgb('#101112'));
    }
  });

  test('custom saber colors retain replay lights independently', () => {
    const settings = {
      ...DEFAULT_VIEWER_SETTINGS,
      customColors: true,
      preferReplayColors: false,
      leftColor: '#aabbcc',
    };
    const colors = resolveColorScheme(environment, colorOverride(settings, map, metadata()));
    expect(colors.leftNote).toEqual(hexToRgb('#aabbcc'));
    expect(colors.environmentLeft).toEqual([0.3, 0.1, 0.2]);
    expect(colors.environmentWhiteBoost).toEqual([0.8, 0.1, 0.2]);
  });

  test('replay sabers can use the map lights including legacy note-to-light fallbacks', () => {
    const settings = { ...DEFAULT_VIEWER_SETTINGS, preferReplayEnvironmentColors: false };
    const colors = resolveColorScheme(environment, colorOverride(settings, map, metadata()));
    expect(colors.leftNote).toEqual([1 / 8, 0.1, 0.2]);
    expect(colors.environmentLeft).toEqual(map.customColors?.leftNote);
    expect(colors.environmentWhite).toEqual(map.customColors?.environmentWhite);
  });

  test('without recorded play settings the map palette remains intact', () => {
    const colors = resolveColorScheme(
      environment,
      colorOverride(DEFAULT_VIEWER_SETTINGS, map, { ...metadata(), hasPlaySettings: false }),
    );
    expect(colors).toEqual(resolveColorScheme(environment, map));
  });

  test('map environment takes priority over the player environment and explicit overrides', () => {
    const settings = {
      ...DEFAULT_VIEWER_SETTINGS,
      useMapEnvironment: true,
      overrideEnvironment: true,
      environmentOverrideId: 'ExplicitEnvironment',
    };
    expect(environmentForSettings(settings, 'MapEnvironment', 'PlayerEnvironment', false)).toBe('MapEnvironment');
    expect(environmentForSettings(settings, 'MapEnvironment', 'PlayerEnvironment', true)).toBe('MapEnvironment');
    expect(
      environmentForSettings({ ...settings, useMapEnvironment: false }, 'MapEnvironment', 'PlayerEnvironment', false),
    ).toBe('PlayerEnvironment');
    expect(
      environmentForSettings({ ...settings, useMapEnvironment: false }, 'MapEnvironment', 'PlayerEnvironment', true),
    ).toBe('ExplicitEnvironment');
  });

  test('legacy palettes migrate; explicit independent settings survive storage and sharing', () => {
    const old = loadViewerSettings(
      {
        getItem: (key) =>
          key === 'chroviewer.settings.v9' ? JSON.stringify({ customColors: true, preferReplayColors: false }) : null,
      },
      false,
    );
    expect(old.customEnvironmentColors).toBe(true);
    expect(old.preferReplayEnvironmentColors).toBe(false);
    expect(old.replayTrailSmoothing).toBe(true);
    expect(old.saberModel).toBe('default');
    expect(old.saberWidth).toBe(1);
    const patch = viewerSettingsPatchSchema.parse({
      customColors: true,
      customEnvironmentColors: false,
      preferReplayColors: false,
      preferReplayEnvironmentColors: true,
      useMapEnvironment: true,
      compositorSyncType: 'wait-for-all',
      compositorWaitSeconds: 60,
      replayTrailSmoothing: false,
      saberModel: 'euc',
      saberWidth: 0.72,
    });
    const saved = { ...DEFAULT_VIEWER_SETTINGS, ...patch };
    const restored = loadViewerSettings({ getItem: () => JSON.stringify(saved) }, false);
    expect(restored).toEqual(saved);
    expect(settingsForShareCategories(restored, ['cosmetics', 'general'])).toMatchObject(patch);
    expect(viewerSettingsPatchSchema.parse({ customColors: true, preferReplayColors: false })).toMatchObject({
      customEnvironmentColors: true,
      preferReplayEnvironmentColors: false,
    });
  });
});
