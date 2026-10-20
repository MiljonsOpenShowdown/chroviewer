import { useEffect, useRef, useState } from 'react';

import { useSearch } from '@tanstack/react-router';

import type { LightshowMode } from '../../core/lighting/basic-light';
import { defaultViewerSettings, sanitizeViewerSettings } from '../../core/viewer-settings';
import { EmbeddedRealtimeScoreTimeline, isEmbeddedRealtimeScoreMessage } from '../live/embedded-realtime-score-sync';
import { replayLightshowMode } from '../live/live-replay';
import type { LiveStatus, LiveTarget } from '../live/live-types';
import { useLiveExperience } from '../live/use-live-experience';
import { useAiPreview } from '../viewer/use-ai-play';
import { useSongTransport } from '../viewer/use-song-transport';
import { useViewerSession } from '../viewer/use-viewer-session';
import { useViewerSources } from '../viewer/use-viewer-sources';
import { dynamicLocationValues, dynamicSettingsPatch, initialViewerSettings } from '../viewer/viewer-embed-settings';
import type { MultiviewTileOptions } from '../viewer/viewer-embed-types';
import {
  renderPerformanceForSearch,
  replaceRenderPerformance,
  updateRenderPerformance,
  type ViewerSearch,
} from '../viewer/viewer-search';
import { quantizedBeatAt } from '../viewer/viewer-timeline';
import { OVERLAY_SETTINGS } from './overlay-defaults';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The search without its unset keys, so it doesn't clear the overlay defaults. */
function definedSearch(search: ViewerSearch) {
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));
}

function waitingLabel(status: LiveStatus, error: string) {
  switch (status) {
    case 'error':
      return error || 'Replay stream unavailable';
    case 'connecting':
      return 'Connecting to TournamentAssistant';
    case 'reconnecting':
      return 'Reconnecting to TournamentAssistant';
    case 'loading':
      return 'Downloading replay map';
    case 'buffering':
      return 'Preparing replay stream';
    case 'paused':
      return 'Player paused';
    default:
      return 'Waiting for replay stream';
  }
}

interface OverlayShellProps {
  multiview?: MultiviewTileOptions;
}

/**
 * Controls-free viewer for broadcast overlays (/overlay). Same engine hooks as
 * ViewerShell, without its UI (player card, timeline, settings), watch party,
 * chat, sharing or showcases, and with OVERLAY_SETTINGS as defaults. The 3D
 * game HUD (score, combo, energy, song time) is always hidden; environment,
 * notes, sabers, walls, bombs, hit scores (HSV) and lights stay.
 *
 * Unlike ViewerShell it doesn't poll its own URL for settings changes; the
 * embedding page changes settings with `beatkhana:viewer-settings` messages.
 */
export function OverlayShell({ multiview }: OverlayShellProps = {}) {
  const routeSearch = useSearch({ strict: false });
  // Tiles only use the broadcast preset when their settings ask for it
  const multiviewBroadcast = multiview?.settings?.qualityPreset === 'broadcast';
  // Raw values in URL/tile form: overlay defaults, then the page's own values
  const [initialValues] = useState(() => ({
    ...OVERLAY_SETTINGS,
    ...(multiview === undefined ? dynamicLocationValues() : multiview.settings),
  }));
  const defined = definedSearch(routeSearch);
  const search: ViewerSearch =
    multiview === undefined
      ? {
          ...OVERLAY_SETTINGS,
          ...defined,
          // A TA player's stream unless the page asks for another source
          liveSource: routeSearch.liveSource ?? (routeSearch.playerId === undefined ? undefined : 'ta'),
        }
      : {
          ...OVERLAY_SETTINGS,
          ...defined,
          ...multiview.settings,
          // A recorded replay must not also open the player's live stream.
          playerId: multiview.replayUrl === undefined ? multiview.playerId : undefined,
          liveSource: multiview.replayUrl === undefined ? ('ta' as const) : undefined,
          masterVolume: multiview.masterVolume,
          hitsoundVolume: multiview.hitsoundVolume,
          disableGameUI: multiview.disableGameUI,
          hidePlatform: multiview.hidePlatform,
          lights: multiview.lights,
          qualityPreset: multiviewBroadcast ? ('broadcast' as const) : undefined,
          maxFps:
            typeof multiview.settings?.maxFps === 'number'
              ? multiview.settings.maxFps
              : multiviewBroadcast
                ? 60
                : undefined,
        };
  const taLiveSource = search.liveSource === 'ta' || search.liveSource === 'cocu';
  const [performance, setPerformance] = useState(() =>
    updateRenderPerformance(renderPerformanceForSearch(search), initialValues),
  );
  // Deterministic like any isolated embed: defaults, then URL/message overrides.
  // Never reads or writes the settings saved on the viewer's own site.
  const [settings, setSettings] = useState(() =>
    sanitizeViewerSettings({
      ...initialViewerSettings(search, defaultViewerSettings()),
      ...dynamicSettingsPatch(initialValues),
    }),
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [error, setError] = useState('');
  const [embeddedLights, setEmbeddedLights] = useState<LightshowMode | null>(null);
  const presetLights = search.qualityPreset === 'broadcast' ? 'static' : null;
  const authoritativeLights = embeddedLights ?? search.lights ?? presetLights;
  const [lightshowMode, setLightshowMode] = useState<LightshowMode>(
    search.lightshow ?? search.lights ?? presetLights ?? (settings.staticLights ? 'static' : 'full'),
  );
  const lightshowModeRef = useRef(lightshowMode);
  const transport = useSongTransport({
    lightshowModeRef,
    settings,
    settingsRef,
  });
  const embeddedScoreTimelineRef = useRef(new EmbeddedRealtimeScoreTimeline());
  const embeddedScoreParentOriginRef = useRef<string | null>(null);
  const embeddedScorePlatformIdsRef = useRef<string[]>([]);
  const lastEmbeddedScoreSignatureRef = useRef('');
  const sources = useViewerSources({
    // TA owns the map/replay lifecycle; generic remote sources would compete with it
    remoteSourcesEnabled: !taLiveSource,
    setError,
    setSettings,
    onClearViewer() {
      transport.clear();
      session.clearViewer();
    },
    onMapLoaded() {
      session.clearMapSelection();
    },
    liveMapCache: multiview?.mapCache,
    sharedParser: multiview?.parser,
    replayUrl: multiview?.replayUrl,
  });
  const session = useViewerSession({
    disableGameUI: search.disableGameUI === true,
    // No game HUD panels on the overlay; the hit-score visualizer stays
    hitScoresOnly: true,
    lightBrightness: search.lightBrightness ?? 1,
    hidePlatform: search.hidePlatform === true,
    hideGameplayNotes: false,
    lightshowMode,
    lightshowModeRef,
    authoritativeLightshowMode: authoritativeLights,
    skipInitialMenuEnvironment:
      search.map !== undefined || search.scoreId !== undefined || search.scoreIdBL !== undefined,
    // No panels on the overlay
    setActivePanel: () => {},
    setError,
    setLightshowMode,
    setSettings,
    persistedSettings: settings,
    settings,
    settingsRef,
    sources,
    transport,
    performance,
    persistSettings: false,
    sharedRenderer: multiview === undefined ? undefined : { host: multiview.host, id: multiview.id },
    sharedTimeline: multiview === undefined ? undefined : { timeline: multiview.timeline, id: multiview.id },
  });
  const multiviewSettingsSignature =
    multiview === undefined
      ? ''
      : JSON.stringify({
          ...multiview.settings,
          masterVolume: multiview.masterVolume,
          hitsoundVolume: multiview.hitsoundVolume,
        });
  useEffect(() => {
    if (multiview === undefined) return;
    const values = {
      ...OVERLAY_SETTINGS,
      ...(multiviewBroadcast ? { maxFps: 60 } : {}),
      ...multiview.settings,
      masterVolume: multiview.masterVolume,
      hitsoundVolume: multiview.hitsoundVolume,
    };
    setPerformance(replaceRenderPerformance(values));
    setSettings((current) => sanitizeViewerSettings({ ...current, ...dynamicSettingsPatch(values) }));
  }, [multiviewSettingsSignature]);
  const liveTarget: LiveTarget | null =
    search.playerId === undefined
      ? null
      : {
          playerId: search.playerId,
          source: search.liveSource,
          tournamentId: search.tournamentId,
          roomId: search.roomId,
          matchId: search.matchId,
          watcherPlayerId: search.watcherPlayerId,
          authToken: search.authToken,
        };
  // Built-in AI, same URL parameters as the viewer: map= plus aiDiff (aiChar)
  // plays that difficulty like the viewer's AI Play button.
  useAiPreview({
    sources,
    session,
    transport,
    setError,
    autoStart:
      multiview === undefined && search.map !== undefined && search.aiDiff !== undefined
        ? { difficulty: search.aiDiff, characteristic: search.aiChar ?? 'Standard' }
        : undefined,
  });
  const taLive = liveTarget?.source === 'ta' || liveTarget?.source === 'cocu';
  useEffect(() => {
    if (!taLive || liveTarget === null || multiview !== undefined) return;
    const timeline = embeddedScoreTimelineRef.current;
    const livePlayerId = liveTarget.playerId;

    function receiveRealtimeScore(event: MessageEvent) {
      // Any page may embed the viewer, so only the sender frame is checked.
      if (event.source !== window.parent) return;
      if (!isEmbeddedRealtimeScoreMessage(event.data, livePlayerId)) return;
      embeddedScoreParentOriginRef.current = event.origin;
      embeddedScorePlatformIdsRef.current = [event.data.playerId, ...event.data.platformIds];
      timeline.add(event.data.score);
    }

    window.addEventListener('message', receiveRealtimeScore);
    return () => {
      window.removeEventListener('message', receiveRealtimeScore);
      timeline.clear();
      embeddedScoreParentOriginRef.current = null;
      embeddedScorePlatformIdsRef.current = [];
      lastEmbeddedScoreSignatureRef.current = '';
    };
  }, [liveTarget?.playerId, taLive]);
  useEffect(() => {
    if (!taLive || liveTarget === null) return;
    const parentOrigin = embeddedScoreParentOriginRef.current;
    const cached = embeddedScoreTimelineRef.current.at(transport.time);
    if (parentOrigin === null || cached === null) return;
    const signature = `${cached.position}\0${cached.signature}`;
    if (signature === lastEmbeddedScoreSignatureRef.current) return;
    lastEmbeddedScoreSignatureRef.current = signature;
    window.parent.postMessage(
      {
        type: 'beatkhana:synced-realtime-score',
        version: 1,
        playerId: liveTarget.playerId,
        platformIds: embeddedScorePlatformIdsRef.current,
        replayTime: transport.time,
        score: cached.score,
        sentAt: Date.now(),
      },
      parentOrigin,
    );
  }, [liveTarget?.playerId, taLive, transport.time]);
  useEffect(() => {
    if (multiview !== undefined) return;

    function applyEmbeddedViewerSettings(event: MessageEvent) {
      const data: unknown = event.data;
      if (event.source !== window.parent || !isRecord(data) || data.type !== 'beatkhana:viewer-settings') return;
      const masterVolume = Number(data.masterVolume);
      const songVolume = Number(data.songVolume);
      const hitsoundVolume = Number(data.hitsoundVolume);
      const settingsPatch = {
        ...(isRecord(data.settings) ? data.settings : {}),
        ...(typeof data.environment === 'string' ? { environment: data.environment } : {}),
      };
      const performancePatch = isRecord(data.performance) ? data.performance : settingsPatch;
      setPerformance((current) => updateRenderPerformance(current, performancePatch));
      setSettings((current) =>
        sanitizeViewerSettings({
          ...current,
          ...dynamicSettingsPatch(settingsPatch),
          ...(Number.isFinite(masterVolume) ? { masterVolume } : {}),
          ...(Number.isFinite(songVolume) ? { songVolume } : {}),
          ...(Number.isFinite(hitsoundVolume) ? { hitsoundVolume } : {}),
        }),
      );
      const lights = data.lights;
      if (lights === 'full-lightshow' || lights === 'full' || lights === 'static' || lights === 'none') {
        setEmbeddedLights(lights);
        session.applyAuthoritativeLightshowMode(lights);
      }
    }

    window.addEventListener('message', applyEmbeddedViewerSettings);
    return () => {
      window.removeEventListener('message', applyEmbeddedViewerSettings);
    };
  }, [multiview !== undefined]);
  const live = useLiveExperience({
    appendReplayHeightEvents: session.appendLiveReplayHeightEvents,
    appendReplayNoteEvents: session.appendLiveReplayNoteEvents,
    refreshReplayDisplay: session.refreshLiveReplayDisplay,
    externalTimeline: multiview !== undefined,
    taSyncGroup: search.syncGroup,
    taCatchupUrl: search.catchupUrl,
    startBarrier: multiview === undefined ? undefined : { id: multiview.id, barrier: multiview.startBarrier },
    hasLiveMap: (hash) => sources.hasLiveMap(hash),
    loadLiveReplay: (hash, replay) => {
      if (taLiveSource && embeddedLights === null && search.lights === undefined) {
        session.applyAuthoritativeLightshowMode(replayLightshowMode(replay));
      }
      return sources.loadLiveReplay(hash, replay);
    },
    selectedKey: session.selectedKey,
    target: liveTarget,
    transport,
  });
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // A recorded replay has no live connection: it is ready once its map and
  // replay are loaded, and stays ready while paused so it remains in sync.
  const replayStatus: LiveStatus =
    error !== '' ? 'error' : transport.duration > 0 && sources.mapMeta !== null ? 'watching' : 'loading';
  useEffect(() => {
    if (multiview === undefined) return;
    multiview.onPlayback({
      playerId: multiview.playerId,
      time: transport.clockRef.current?.currentTime() ?? transport.time,
      duration: transport.duration,
      beat: quantizedBeatAt(transport.clockRef.current?.currentTime() ?? transport.time, sources.songBpm, 1 / 1000),
      bpm: sources.songBpm,
      playing: transport.playing,
      status: multiview.replayUrl === undefined ? live.status : replayStatus,
      error,
      map: sources.mapMeta,
      mapHash: sources.mapIdentity?.hash ?? null,
      streamId: multiview.replayUrl === undefined && live.streamId !== '' ? live.streamId : null,
      playbackRate: transport.clockRef.current?.getRate() ?? 1,
      seek: transport.seek,
      play: () => transportRef.current.play(),
      pause: () => transportRef.current.pause(),
      correctDrift: (time) => transport.clockRef.current?.correctDrift(time),
    });
  }, [
    error,
    live.status,
    live.streamId,
    multiview,
    sources.mapIdentity,
    sources.mapMeta,
    sources.songBpm,
    transport.duration,
    transport.playing,
    transport.time,
  ]);

  // Multiview tiles draw into the shared multiview canvas
  if (multiview !== undefined) return null;
  const showing = taLive
    ? live.status === 'watching' && transport.playing && sources.mapMeta !== null && transport.duration > 0
    : error === '';
  return (
    <main className="relative size-full overflow-hidden bg-black">
      <canvas ref={session.canvasRef} className="absolute inset-0 size-full" />
      {!showing && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black px-4 text-center font-bold text-white/70 uppercase">
          <span className="flex items-center gap-3 text-[clamp(12px,1.25vw,24px)] leading-tight">
            {live.status !== 'error' && error === '' && (
              <i className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent" />
            )}
            {taLive ? waitingLabel(live.status, error) : error}
          </span>
        </div>
      )}
    </main>
  );
}
