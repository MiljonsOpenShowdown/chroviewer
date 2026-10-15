import * as z from 'zod/mini';

import type { SharedViewerSettings } from '../../core/share-link';
import { viewerSettingsPatchSchema } from '../../core/viewer-settings';
import {
  BROADCAST_RENDER_PERFORMANCE,
  DEFAULT_RENDER_PERFORMANCE,
  mirrorResolutionForQuality,
  type RenderPerformanceOptions,
} from '../../renderer/render-performance';

export type ViewerShareSource =
  | { type: 'map'; mapKey: string; difficultyIndex?: number }
  | { type: 'replay'; replayUrl: string }
  | { type: 'score'; scoreId: string }
  | { type: 'score-bl'; scoreId: string }
  | {
      type: 'live';
      playerId: string;
      liveSource?: 'scoresaber' | 'ta' | 'cocu';
      tournamentId?: string;
      roomId?: string;
      matchId?: string;
    };

const searchIdentifierSchema = z.union([z.string(), z.pipe(z.int(), z.transform(String))]);
const mapKeySchema = z.pipe(
  searchIdentifierSchema.check(z.regex(/^[0-9a-f]+$/i)),
  z.transform((value) => value.toLowerCase()),
);
const scoreIdSchema = searchIdentifierSchema.check(z.regex(/^\d+$/));
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const remoteSourceUrlSchema = z.pipe(
  z.string().check(z.maxLength(4096)),
  z.url({ protocol: /^https?$/ }).check(
    z.refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === 'https:' || loopbackHostnames.has(url.hostname);
    }),
  ),
);
const mapSourceSchema = z.union([mapKeySchema, remoteSourceUrlSchema]);
const nonnegativeNumberSchema = z.number().check(z.nonnegative());
const unitNumberSchema = z.number().check(z.minimum(0), z.maximum(1));
const renderScaleSchema = z.number().check(z.minimum(0.5), z.maximum(1.5));
const maxFpsSchema = z.int().check(z.minimum(1), z.maximum(240));
const msaaSamplesSchema = z.int().check(z.minimum(0), z.maximum(8));
const mirrorResolutionSchema = z.int().check(z.minimum(0), z.maximum(4096));
const postBloomWidthSchema = z.int().check(z.minimum(64), z.maximum(2048));
const bloomFogSizeSchema = z.int().check(z.minimum(64), z.maximum(1024));
const outputWidthSchema = z.int().check(z.minimum(64), z.maximum(7680));
const outputHeightSchema = z.int().check(z.minimum(64), z.maximum(4320));
const fovSchema = z.number().check(z.minimum(60), z.maximum(120));
const audioOffsetSchema = z.int().check(z.minimum(-1000), z.maximum(1000));
const difficultyIndexSchema = z.int().check(z.nonnegative());
const liveIdSchema = searchIdentifierSchema.check(z.minLength(1), z.maxLength(128));
const livePlayerIdSchema = liveIdSchema.check(z.regex(/^\d+$/));

export const viewerSearchSchema = z.pipe(
  z.object({
    party: z.catch(z.optional(livePlayerIdSchema), undefined),
    map: z.catch(z.optional(mapSourceSchema), undefined),
    replayUrl: z.catch(z.optional(remoteSourceUrlSchema), undefined),
    scoreId: z.catch(z.optional(scoreIdSchema), undefined),
    scoreIdBL: z.catch(z.optional(scoreIdSchema), undefined),
    difficulty: z.catch(z.optional(difficultyIndexSchema), undefined),
    beat: z.catch(z.optional(nonnegativeNumberSchema), undefined),
    previewSource: z.catch(z.optional(z.enum(['map', 'scoresaber', 'beatleader'])), undefined),
    previewDifficulty: z.catch(z.optional(difficultyIndexSchema), undefined),
    previewCharacteristic: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(64))), undefined),
    previewStartSeconds: z.catch(z.optional(nonnegativeNumberSchema), undefined),
    autoplay: z.catch(z.optional(z.boolean()), undefined),
    hideUI: z.catch(z.optional(z.boolean()), undefined),
    isolatedSettings: z.catch(z.optional(z.boolean()), undefined),
    multiview: z.catch(z.optional(z.boolean()), undefined),
    showcase: z.catch(z.optional(z.boolean()), undefined),
    showcaseConfig: z.catch(z.optional(z.string().check(z.maxLength(250_000))), undefined),
    poolShowcase: z.catch(z.optional(z.boolean()), undefined),
    poolShowcaseConfig: z.catch(z.optional(z.string().check(z.maxLength(250_000))), undefined),
    disableGameUI: z.catch(z.optional(z.boolean()), undefined),
    hidePlatform: z.catch(z.optional(z.boolean()), undefined),
    lightshow: z.catch(z.optional(z.literal('full-lightshow')), undefined),
    lights: z.catch(z.optional(z.enum(['full', 'full-lightshow', 'static', 'none'])), undefined),
    masterVolume: z.catch(z.optional(unitNumberSchema), undefined),
    songVolume: z.catch(z.optional(unitNumberSchema), undefined),
    hitsoundVolume: z.catch(z.optional(unitNumberSchema), undefined),
    hitsounds: z.catch(z.optional(z.boolean()), undefined),
    qualityPreset: z.catch(z.optional(z.literal('broadcast')), undefined),
    maxFps: z.catch(z.optional(maxFpsSchema), undefined),
    renderScale: z.catch(z.optional(renderScaleSchema), undefined),
    graphicsQuality: z.catch(z.optional(z.enum(['none', 'low', 'medium', 'high'])), undefined),
    mirrorQuality: z.catch(z.optional(z.enum(['none', 'low', 'medium', 'high'])), undefined),
    mirrorResolution: z.catch(z.optional(mirrorResolutionSchema), undefined),
    mirrorMsaaSamples: z.catch(z.optional(msaaSamplesSchema), undefined),
    msaaSamples: z.catch(z.optional(msaaSamplesSchema), undefined),
    postBloomWidth: z.catch(z.optional(postBloomWidthSchema), undefined),
    bloomFogSize: z.catch(z.optional(bloomFogSizeSchema), undefined),
    screenDisplacement: z.catch(z.optional(z.boolean()), undefined),
    outputWidth: z.catch(z.optional(outputWidthSchema), undefined),
    outputHeight: z.catch(z.optional(outputHeightSchema), undefined),
    camera: z.catch(z.optional(z.enum(['static', 'follow', 'first-person'])), undefined),
    fov: z.catch(z.optional(fovSchema), undefined),
    audioOffsetMs: z.catch(z.optional(audioOffsetSchema), undefined),
    settings: z.catch(z.optional(viewerSettingsPatchSchema), undefined),
    playerId: z.catch(z.optional(livePlayerIdSchema), undefined),
    liveSource: z.catch(z.optional(z.enum(['scoresaber', 'ta', 'cocu'])), undefined),
    tournamentId: z.catch(z.optional(liveIdSchema), undefined),
    roomId: z.catch(z.optional(liveIdSchema), undefined),
    matchId: z.catch(z.optional(liveIdSchema), undefined),
    watcherPlayerId: z.catch(z.optional(livePlayerIdSchema), undefined),
    authToken: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(4096))), undefined),
  }),
  z.transform((search) => {
    if (search.party !== undefined) {
      return {
        ...search,
        map: undefined,
        replayUrl: undefined,
        scoreId: undefined,
        scoreIdBL: undefined,
        difficulty: undefined,
        beat: undefined,
        previewSource: undefined,
        previewDifficulty: undefined,
        previewCharacteristic: undefined,
        previewStartSeconds: undefined,
        autoplay: undefined,
        playerId: undefined,
        tournamentId: undefined,
        roomId: undefined,
        matchId: undefined,
        watcherPlayerId: undefined,
        authToken: undefined,
      };
    }
    if (search.playerId !== undefined) {
      return {
        ...search,
        map: undefined,
        replayUrl: undefined,
        scoreId: undefined,
        scoreIdBL: undefined,
        difficulty: undefined,
        beat: undefined,
        previewSource: undefined,
        previewDifficulty: undefined,
        previewCharacteristic: undefined,
        previewStartSeconds: undefined,
      };
    }
    if (search.replayUrl !== undefined)
      return { ...search, map: undefined, scoreId: undefined, scoreIdBL: undefined, difficulty: undefined };
    if (search.scoreId !== undefined) return { ...search, map: undefined, scoreIdBL: undefined, difficulty: undefined };
    if (search.scoreIdBL !== undefined) return { ...search, map: undefined, scoreId: undefined, difficulty: undefined };
    if (search.previewSource !== undefined && search.map === undefined) {
      return {
        ...search,
        previewSource: undefined,
        previewDifficulty: undefined,
        previewCharacteristic: undefined,
        previewStartSeconds: undefined,
      };
    }
    return search;
  }),
);

export type ViewerSearch = z.infer<typeof viewerSearchSchema>;

export function hasExternallyConfiguredSettings(search: ViewerSearch) {
  return (
    search.settings !== undefined ||
    search.qualityPreset !== undefined ||
    search.maxFps !== undefined ||
    search.renderScale !== undefined ||
    search.graphicsQuality !== undefined ||
    search.mirrorQuality !== undefined ||
    search.mirrorResolution !== undefined ||
    search.mirrorMsaaSamples !== undefined ||
    search.msaaSamples !== undefined ||
    search.postBloomWidth !== undefined ||
    search.bloomFogSize !== undefined ||
    search.screenDisplacement !== undefined ||
    search.outputWidth !== undefined ||
    search.outputHeight !== undefined ||
    search.masterVolume !== undefined ||
    search.songVolume !== undefined ||
    search.hitsoundVolume !== undefined ||
    search.hitsounds !== undefined ||
    search.camera !== undefined ||
    search.fov !== undefined ||
    search.audioOffsetMs !== undefined ||
    search.lights !== undefined ||
    search.lightshow !== undefined
  );
}

export function hasConfiguredShowcase(search: Pick<ViewerSearch, 'showcase' | 'showcaseConfig'>) {
  return search.showcase === true && search.showcaseConfig !== undefined;
}

export function hasConfiguredPoolShowcase(search: Pick<ViewerSearch, 'poolShowcase' | 'poolShowcaseConfig'>) {
  return search.poolShowcase === true && search.poolShowcaseConfig !== undefined;
}

export function renderPerformanceForSearch(search: ViewerSearch): RenderPerformanceOptions {
  const preset = search.qualityPreset === 'broadcast' ? BROADCAST_RENDER_PERFORMANCE : DEFAULT_RENDER_PERFORMANCE;
  const mirrorQuality = search.mirrorQuality ?? search.graphicsQuality;
  const outputSize =
    search.outputWidth === undefined || search.outputHeight === undefined
      ? {}
      : { outputWidth: search.outputWidth, outputHeight: search.outputHeight };
  return {
    ...preset,
    ...(mirrorQuality === undefined ? {} : { mirrorResolution: mirrorResolutionForQuality(mirrorQuality) }),
    ...(search.maxFps === undefined ? {} : { maxFps: search.maxFps }),
    ...(search.msaaSamples === undefined ? {} : { msaaSamples: search.msaaSamples }),
    ...(search.mirrorResolution === undefined ? {} : { mirrorResolution: search.mirrorResolution }),
    ...(search.mirrorMsaaSamples === undefined ? {} : { mirrorMsaaSamples: search.mirrorMsaaSamples }),
    ...(search.postBloomWidth === undefined ? {} : { postBloomWidth: search.postBloomWidth }),
    ...(search.bloomFogSize === undefined ? {} : { bloomFogSize: search.bloomFogSize }),
    ...outputSize,
  };
}

function finiteNumber(value: unknown, minimum: number, maximum: number) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : undefined;
}

function finiteInteger(value: unknown, minimum: number, maximum: number) {
  const number = finiteNumber(value, minimum, maximum);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

export function updateRenderPerformance(
  current: RenderPerformanceOptions,
  values: Record<string, unknown>,
): RenderPerformanceOptions {
  let next =
    values.qualityPreset === 'broadcast'
      ? { ...BROADCAST_RENDER_PERFORMANCE }
      : values.qualityPreset === '' || values.qualityPreset === null
        ? { ...DEFAULT_RENDER_PERFORMANCE }
        : { ...current };
  const maxFps = finiteInteger(values.maxFps, 1, 240);
  const msaaSamples = finiteInteger(values.msaaSamples, 0, 8);
  const mirrorResolution = finiteInteger(values.mirrorResolution, 0, 4096);
  const mirrorMsaaSamples = finiteInteger(values.mirrorMsaaSamples, 0, 8);
  const postBloomWidth = finiteInteger(values.postBloomWidth, 64, 2048);
  const bloomFogSize = finiteInteger(values.bloomFogSize, 64, 1024);
  const mirrorQuality = values.mirrorQuality ?? values.graphicsQuality;
  if (maxFps !== undefined) next.maxFps = maxFps;
  if (msaaSamples !== undefined) next.msaaSamples = msaaSamples;
  if (mirrorQuality === 'none' || mirrorQuality === 'low' || mirrorQuality === 'medium' || mirrorQuality === 'high') {
    next.mirrorResolution = mirrorResolutionForQuality(mirrorQuality);
  }
  if (mirrorResolution !== undefined) next.mirrorResolution = mirrorResolution;
  if (mirrorMsaaSamples !== undefined) next.mirrorMsaaSamples = mirrorMsaaSamples;
  if (postBloomWidth !== undefined) next.postBloomWidth = postBloomWidth;
  if (bloomFogSize !== undefined) next.bloomFogSize = bloomFogSize;

  if ('outputWidth' in values || 'outputHeight' in values) {
    const outputWidth = finiteInteger(values.outputWidth, 64, 7680);
    const outputHeight = finiteInteger(values.outputHeight, 64, 4320);
    next =
      outputWidth === undefined || outputHeight === undefined
        ? { ...next, outputWidth: undefined, outputHeight: undefined }
        : { ...next, outputWidth, outputHeight };
  }
  return next;
}

export function replaceRenderPerformance(values: Record<string, unknown>): RenderPerformanceOptions {
  return updateRenderPerformance(DEFAULT_RENDER_PERFORMANCE, {
    qualityPreset: '',
    ...values,
  });
}

export function isRemoteSourceUrl(value: string) {
  return remoteSourceUrlSchema.safeParse(value).success;
}

export function viewerSearchForShare(
  source: ViewerShareSource,
  beat: number | undefined,
  settings?: SharedViewerSettings,
  lightshow?: 'full-lightshow',
): ViewerSearch {
  if (source.type === 'live') {
    return {
      playerId: source.playerId,
      liveSource: source.liveSource,
      tournamentId: source.tournamentId,
      roomId: source.roomId,
      matchId: source.matchId,
      settings,
      lightshow,
    };
  }
  const sharedBeat = beat !== undefined && beat > 0 ? Number(beat.toFixed(6)) : undefined;
  if (source.type === 'map') {
    return {
      map: source.mapKey,
      difficulty: source.difficultyIndex,
      beat: sharedBeat,
      settings,
      lightshow,
    };
  }
  if (source.type === 'replay') return { replayUrl: source.replayUrl, beat: sharedBeat, settings, lightshow };
  if (source.type === 'score') return { scoreId: source.scoreId, beat: sharedBeat, settings, lightshow };
  return { scoreIdBL: source.scoreId, beat: sharedBeat, settings, lightshow };
}
