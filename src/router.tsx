import type { QueryClient } from '@tanstack/react-query';
import { createRouter, defaultParseSearch } from '@tanstack/react-router';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { z } from 'zod';

import { createQueryClient } from './app/query-client';
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
  showcaseConfig: ['showcaseconfig'],
  poolShowcaseConfig: ['poolshowcaseconfig'],
};

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
    const entry = [...searchParams].find(([key]) => aliases.includes(key.toLowerCase()));
    if (entry !== undefined) parsed[canonical] = entry[1];
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

function stringifyUrlSearch(search: Record<string, RouterSearchValue>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) appendSearchValue(searchParams, key, value);
  const next = searchParams.toString();
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

function PendingFallback() {
  return (
    <main className="flex h-dvh items-center justify-center bg-transparent text-white">
      <LoaderCircle className="size-11 animate-spin" strokeWidth={1.75} aria-label="Loading" />
    </main>
  );
}

function ErrorFallback({ error }: { error: unknown }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-transparent text-white">
      <AlertCircle className="size-11" strokeWidth={1.75} />
      <span className="text-lg font-semibold tracking-wide">Something went wrong</span>
      {error instanceof Error && error.message !== '' && (
        <span className="max-w-[min(34rem,calc(100vw-1.5rem))] text-sm text-white/60">{error.message}</span>
      )}
      <button
        className="rounded-full border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload
      </button>
    </main>
  );
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
