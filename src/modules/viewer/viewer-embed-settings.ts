import { hsvPresets } from '../../core/replay/hsv-presets';
import { DEFAULT_VIEWER_SETTINGS, sanitizeViewerSettings, type ViewerSettings } from '../../core/viewer-settings';
import type { ViewerSearch } from './viewer-search';

// Settings logic shared by the full viewer and the overlay shell, kept apart
// from viewer-shell so the overlay route doesn't bundle the full viewer UI.

/** Viewer settings for a page's search: `saved` first, then the URL overrides. */
export function initialViewerSettings(search: ViewerSearch, saved: ViewerSettings) {
  const broadcastSettings =
    search.qualityPreset === 'broadcast'
      ? {
          graphicsQuality: 'none' as const,
          renderScale: 0.85,
          replayTrailSamples: 12,
          screenDisplacementEffects: false,
        }
      : {};
  return sanitizeViewerSettings({
    ...saved,
    ...broadcastSettings,
    ...search.settings,
    ...(search.lightshow === 'full-lightshow' ? { staticLights: false } : {}),
    ...(search.masterVolume === undefined ? {} : { masterVolume: search.masterVolume }),
    ...(search.songVolume === undefined ? {} : { songVolume: search.songVolume }),
    ...(search.hitsoundVolume === undefined ? {} : { hitsoundVolume: search.hitsoundVolume }),
    ...(search.hitsounds === undefined ? {} : { hitsounds: search.hitsounds }),
    ...(search.renderScale === undefined ? {} : { renderScale: search.renderScale }),
    ...(search.graphicsQuality === undefined ? {} : { graphicsQuality: search.graphicsQuality }),
    ...(search.mirrorQuality === undefined ? {} : { graphicsQuality: search.mirrorQuality }),
    ...(search.screenDisplacement === undefined ? {} : { screenDisplacementEffects: search.screenDisplacement }),
    ...(search.camera === undefined ? {} : { replayCamera: search.camera }),
    ...(search.fov === undefined ? {} : { replayCameraFov: search.fov }),
    ...(search.audioOffsetMs === undefined ? {} : { audioOffsetMs: search.audioOffsetMs }),
    ...(search.liveSource === 'ta' || search.liveSource === 'cocu'
      ? {
          preferReplayColors: search.settings?.preferReplayColors ?? true,
          preferReplayEnvironment: search.settings?.preferReplayEnvironment ?? true,
          preferReplayHsvProfile: search.settings?.preferReplayHsvProfile ?? true,
        }
      : {}),
    // A bundled HSV profile replaces the player's own
    ...(search.hsv === undefined
      ? {}
      : { overrideHsvProfile: true, preferReplayHsvProfile: false, hsvProfile: hsvPresets[search.hsv] }),
  });
}

export function dynamicSettingsPatch(values: Record<string, unknown>) {
  const performanceKeys = new Set([
    'qualityPreset',
    'maxFps',
    'msaaSamples',
    'mirrorQuality',
    'mirrorResolution',
    'mirrorMsaaSamples',
    'postBloomWidth',
    'bloomFogSize',
    'outputWidth',
    'outputHeight',
    'screenDisplacement',
    // Keep the legacy query parameter live without rebuilding the entire scene.
    // It now controls only the mirror target, just like mirrorQuality.
    'graphicsQuality',
  ]);
  const patch = Object.fromEntries(Object.entries(values).filter(([key]) => !performanceKeys.has(key)));
  return {
    ...(values.qualityPreset === '' || values.qualityPreset === null
      ? {
          renderScale: DEFAULT_VIEWER_SETTINGS.renderScale,
          replayTrailSamples: DEFAULT_VIEWER_SETTINGS.replayTrailSamples,
          screenDisplacementEffects: DEFAULT_VIEWER_SETTINGS.screenDisplacementEffects,
        }
      : {}),
    ...(values.qualityPreset === 'broadcast'
      ? { renderScale: 0.85, replayTrailSamples: 12, screenDisplacementEffects: false }
      : {}),
    ...(typeof values.customColors === 'boolean' && values.customEnvironmentColors === undefined
      ? { customEnvironmentColors: values.customColors }
      : {}),
    ...(typeof values.preferReplayColors === 'boolean' && values.preferReplayEnvironmentColors === undefined
      ? { preferReplayEnvironmentColors: values.preferReplayColors }
      : {}),
    ...patch,
    ...('screenDisplacement' in values ? { screenDisplacementEffects: values.screenDisplacement } : {}),
  };
}

export function dynamicLocationValues() {
  const values: Record<string, unknown> = {};
  const settingKeys = new Map(Object.keys(DEFAULT_VIEWER_SETTINGS).map((key) => [key.toLowerCase(), key]));
  const performanceKeys = new Map(
    [
      'qualityPreset',
      'maxFps',
      'msaaSamples',
      'mirrorQuality',
      'mirrorResolution',
      'mirrorMsaaSamples',
      'postBloomWidth',
      'bloomFogSize',
      'outputWidth',
      'outputHeight',
      'screenDisplacement',
    ].map((key) => [key.toLowerCase(), key]),
  );
  const aliases = new Map([
    ['camera', 'replayCamera'],
    ['fov', 'replayCameraFov'],
  ]);
  for (const [rawKey, rawValue] of new URLSearchParams(window.location.search)) {
    const lower = rawKey.toLowerCase();
    const key = performanceKeys.get(lower) ?? settingKeys.get(lower) ?? aliases.get(lower);
    if (key === undefined) continue;
    const defaultValue = DEFAULT_VIEWER_SETTINGS[key as keyof typeof DEFAULT_VIEWER_SETTINGS];
    values[key] =
      key === 'screenDisplacement'
        ? rawValue.toLowerCase() === 'true'
        : typeof defaultValue === 'number'
          ? Number(rawValue)
          : typeof defaultValue === 'boolean'
            ? rawValue.toLowerCase() === 'true'
            : rawValue;
  }
  return values;
}
