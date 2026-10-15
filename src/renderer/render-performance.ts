import type { MirrorQuality } from './quality';

export const DEFAULT_MAX_FPS = 120;
export const DEFAULT_MSAA_SAMPLES = 4;
export const DEFAULT_MIRROR_MSAA_SAMPLES = 2;
export const DEFAULT_POST_BLOOM_WIDTH = 928;
export const DEFAULT_BLOOM_FOG_SIZE = 512;

export interface RenderPerformanceOptions {
  maxFps: number;
  msaaSamples: number;
  mirrorResolution?: number;
  mirrorMsaaSamples?: number;
  postBloomWidth: number;
  bloomFogSize: number;
  outputWidth?: number;
  outputHeight?: number;
}

export const DEFAULT_RENDER_PERFORMANCE: RenderPerformanceOptions = {
  maxFps: DEFAULT_MAX_FPS,
  msaaSamples: DEFAULT_MSAA_SAMPLES,
  postBloomWidth: DEFAULT_POST_BLOOM_WIDTH,
  bloomFogSize: DEFAULT_BLOOM_FOG_SIZE,
};

export const BROADCAST_RENDER_PERFORMANCE: RenderPerformanceOptions = {
  maxFps: 60,
  msaaSamples: 2,
  mirrorResolution: 0,
  mirrorMsaaSamples: 0,
  postBloomWidth: 640,
  bloomFogSize: 256,
};

export function broadcastSettingsForPlayerCount(playerCount: number) {
  const crowded = playerCount >= 5;
  const medium = playerCount >= 3;
  return {
    ...BROADCAST_RENDER_PERFORMANCE,
    qualityPreset: 'broadcast',
    // Keep a cadence that divides evenly into the usual 60 Hz OBS output.
    // Scale per-tile GPU work instead of alternating 16/33 ms frames at 45 Hz.
    maxFps: 60,
    renderScale: crowded ? 0.65 : medium ? 0.75 : 0.85,
    // A positive sample count still allocates a multisample target and resolve.
    msaaSamples: medium ? 0 : 2,
    mirrorQuality: 'none',
    postBloomWidth: crowded ? 384 : medium ? 512 : 640,
    bloomFogSize: crowded ? 128 : medium ? 192 : 256,
    screenDisplacement: false,
    replayTrailSamples: crowded ? 8 : medium ? 10 : 12,
    syncThresholdMs: 200,
    syncIntervalMs: 2000,
  };
}

export function mirrorResolutionForQuality(quality: MirrorQuality) {
  if (quality === 'none') return 0;
  if (quality === 'low') return 512;
  if (quality === 'medium') return 1024;
  return 2048;
}
