import type { MultiviewPlayerDefaults } from '../multiview/multiview-shell';

/**
 * Defaults of the /overlay route, the broadcast look MiljonsOpenShowdown
 * overlays use. URL parameters, multiview tile settings and
 * `beatkhana:viewer-settings` messages still override any of these.
 *
 * Keys are the same as URL parameters and multiview tile `settings`: search
 * parameters (fov, lights, hsv, ...) and viewer settings (replayTrailSamples, ...).
 */
export const OVERLAY_SETTINGS: Record<string, string | number | boolean> = {
  // Full quality, not the broadcast preset
  qualityPreset: '',
  fov: 80,
  lightBrightness: 0.75,
  screenDisplacement: false,
  mirrorQuality: 'none',
  mirrorResolution: 0,
  renderScale: 0.9,
  // Saber trails 60% shorter than the viewer's 18 replay frames
  replayTrailSamples: 7,
  hsv: 'mos',
  saberModel: 'mos-cc',
  // The map's own stage, not the one the player picked in-game
  useMapEnvironment: true,
  preferReplayColors: true,
  // Overlays play no hitsounds
  hitsoundVolume: 0,
};

/** Multiview player fields a `beatkhana:multiview-config` may leave out on /overlay. */
export const OVERLAY_MULTIVIEW_PLAYER_DEFAULTS: MultiviewPlayerDefaults = {
  visible: true,
  hitsoundVolume: 0,
  disableGameUI: false,
  lights: 'full',
  settings: OVERLAY_SETTINGS,
};
