import type { QueryClient } from '@tanstack/react-query';
import { createRouter, defaultParseSearch } from '@tanstack/react-router';
import { z } from 'zod';

import { createQueryClient } from './app/query-client';
import { ErrorFallback, PendingFallback } from './app/route-fallbacks';
import { routeTree } from './routeTree.gen';

type RouterSearchValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RouterSearchValue[]
  | { readonly [key: string]: RouterSearchValue };

export interface RouterContext {
  queryClient: QueryClient;
}

const replaySaberSearchKeys = [
  'preferReplayColors',
  'preferReplayEnvironmentColors',
  'customEnvironmentColors',
  'useMapEnvironment',
  'preferReplayEnvironment',
  'overrideEnvironment',
  'environmentOverrideId',
  'environmentLeftColor',
  'environmentRightColor',
  'environmentWhiteColor',
  'environmentLeftBoostColor',
  'environmentRightBoostColor',
  'environmentWhiteBoostColor',
  'compositorSyncType',
  'compositorWaitSeconds',
  'customColors',
  'leftColor',
  'rightColor',
  'showSabers',
  'saberModel',
  'saberScale',
  'saberWidth',
  'mosSaberBrightness',
  'saberBladeLength',
  'saberBladeThickness',
  'saberCoreThickness',
  'saberCoreInset',
  'showSaberTrails',
  'replayTrailShape',
  'replayTrailLength',
  'replayTrailThinness',
  'replayTrailSamples',
  'replayTrailFade',
  'replayTrailOpacity',
  'replayTrailMotionThreshold',
  'replayTrailSmoothing',
  'saberGripLength',
  'saberGripThickness',
  'saberGuardSize',
  'saberGuardThickness',
  'saberCollarSize',
  'saberCollarThickness',
  'saberCollarSpacing',
  'saberRingCount',
  'saberRingSize',
  'saberRingThickness',
  'saberRingSpacing',
  'saberPommelLength',
  'saberPommelThickness',
  'saberXOffset',
  'saberYOffset',
  'saberZOffset',
  'saberXRotation',
  'saberYRotation',
  'saberZRotation',
] as const;

const searchKeyAliases = new Map(
  Object.entries({
    ...Object.fromEntries(replaySaberSearchKeys.map((key) => [key.toLowerCase(), key])),
    saber: 'saberModel',
    map: 'map',
    replayurl: 'replayUrl',
    scoreid: 'scoreId',
    ssscoreid: 'scoreId',
    difficulty: 'difficulty',
    beat: 'beat',
    autoplay: 'autoplay',
    hideui: 'hideUI',
    isolatedsettings: 'isolatedSettings',
    multiview: 'multiview',
    showcase: 'showcase',
    showcaseconfig: 'showcaseConfig',
    poolshowcase: 'poolShowcase',
    poolshowcaseconfig: 'poolShowcaseConfig',
    disablegameui: 'disableGameUI',
    hitscoresonly: 'hitScoresOnly',
    lightbrightness: 'lightBrightness',
    hsv: 'hsv',
    catchupurl: 'catchupUrl',
    liveurl: 'liveUrl',
    hideplatform: 'hidePlatform',
    lightshow: 'lightshow',
    lights: 'lights',
    mastervolume: 'masterVolume',
    songvolume: 'songVolume',
    hitsoundvolume: 'hitsoundVolume',
    hitsounds: 'hitsounds',
    qualitypreset: 'qualityPreset',
    maxfps: 'maxFps',
    renderscale: 'renderScale',
    graphicsquality: 'graphicsQuality',
    mirrorquality: 'mirrorQuality',
    mirrorresolution: 'mirrorResolution',
    mirrormsaasamples: 'mirrorMsaaSamples',
    msaasamples: 'msaaSamples',
    postbloomwidth: 'postBloomWidth',
    bloomfogsize: 'bloomFogSize',
    screendisplacement: 'screenDisplacement',
    outputwidth: 'outputWidth',
    outputheight: 'outputHeight',
    camera: 'camera',
    fov: 'fov',
    audiooffsetms: 'audioOffsetMs',
    settings: 'settings',
    party: 'party',
    playerid: 'playerId',
    livesource: 'liveSource',
    tournamentid: 'tournamentId',
    roomid: 'roomId',
    matchid: 'matchId',
    watcherplayerid: 'watcherPlayerId',
    authtoken: 'authToken',
    syncgroup: 'syncGroup',
    ss: 'ss',
    bl: 'bl',
  }),
);

const stringSearchAliases = {
  party: ['party'],
  map: ['map'],
  replayUrl: ['replayurl'],
  scoreId: ['scoreid', 'ssscoreid'],
  playerId: ['playerid'],
  liveSource: ['livesource'],
  tournamentId: ['tournamentid'],
  roomId: ['roomid'],
  matchId: ['matchid'],
  watcherPlayerId: ['watcherplayerid'],
  authToken: ['authtoken'],
  syncGroup: ['syncgroup'],
  ss: ['ss'],
  bl: ['bl'],
  catchupUrl: ['catchupurl'],
  liveUrl: ['liveurl'],
  showcaseConfig: ['showcaseconfig'],
  poolShowcaseConfig: ['poolshowcaseconfig'],
};

// /br score ID lists: a repeated key (legacy ss=1&ss=2) joins into the canonical comma list ss=1,2
const commaListSearchKeys = new Set(['ss', 'bl']);
// /br replay URLs may contain commas, so they repeat the key instead; a repeated key stays an array
const repeatedSearchKeys = new Set(['replayUrl']);

export function parseUrlSearch(search: string) {
  const raw = z.record(z.string(), z.json()).parse(defaultParseSearch(search));
  const parsed: Record<string, RouterSearchValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = searchKeyAliases.get(key.toLowerCase());
    if (canonical === undefined) {
      parsed[key] = value;
      continue;
    }
    const direct = key.toLowerCase() === canonical.toLowerCase();
    if (parsed[canonical] === undefined || direct) parsed[canonical] = value;
  }
  const searchParams = new URLSearchParams(search);
  for (const [canonical, aliases] of Object.entries(stringSearchAliases)) {
    const values = [...searchParams].filter(([key]) => aliases.includes(key.toLowerCase())).map(([, value]) => value);
    const first = values[0];
    if (first === undefined) continue;
    parsed[canonical] = commaListSearchKeys.has(canonical)
      ? values.join(',')
      : repeatedSearchKeys.has(canonical) && values.length > 1
        ? values
        : first;
  }
  const nestedSettings: Record<string, RouterSearchValue> =
    typeof parsed.settings === 'object' && parsed.settings !== null && !Array.isArray(parsed.settings)
      ? { ...parsed.settings }
      : {};
  const legacyReplayTrailShape = nestedSettings.replayTrailShape;
  if (nestedSettings.replayTrailStyle === undefined && legacyReplayTrailShape !== undefined) {
    nestedSettings.replayTrailStyle = legacyReplayTrailShape;
  }
  delete nestedSettings.replayTrailShape;
  for (const key of replaySaberSearchKeys) {
    if (parsed[key] === undefined) continue;
    nestedSettings[key === 'replayTrailShape' ? 'replayTrailStyle' : key] = parsed[key];
  }
  if (Object.keys(nestedSettings).length > 0) parsed.settings = nestedSettings;
  return parsed;
}

export function stringifyUrlSearch(search: Record<string, RouterSearchValue>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) appendSearchValue(searchParams, key, value);
  // Score ID lists keep their commas readable (ss=1,2, as links are written), so the router leaves them as typed
  const next = searchParams
    .toString()
    .split('&')
    .map((pair) => (commaListSearchKeys.has(pair.slice(0, pair.indexOf('='))) ? pair.replaceAll('%2C', ',') : pair))
    .join('&');
  return next === '' ? '' : `?${next}`;
}

function appendSearchValue(searchParams: URLSearchParams, key: string, value: RouterSearchValue) {
  if (value === null || value === undefined || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) appendSearchValue(searchParams, key, item);
    return;
  }
  searchParams.append(key, value instanceof Object ? JSON.stringify(value) : String(value));
}

export function getRouter() {
  const queryClient = createQueryClient();

  return createRouter({
    routeTree,
    context: { queryClient },
    defaultErrorComponent: ErrorFallback,
    defaultOnCatch: (error) => {
      console.error(error);
    },
    defaultPendingComponent: PendingFallback,
    defaultPreload: 'intent',
    defaultPreloadDelay: 30,
    defaultViewTransition: false,
    scrollRestoration: true,
    parseSearch: parseUrlSearch,
    stringifySearch: stringifyUrlSearch,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
