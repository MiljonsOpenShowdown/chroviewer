import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';

import { useRouter, useSearch } from '@tanstack/react-router';
import {
  AlertCircle,
  Download,
  LoaderCircle,
  Menu,
  Pause,
  Play,
  RotateCcw,
  UsersRound,
  Volume2,
  X,
} from 'lucide-react';
import { useTranslations } from 'use-intl';

import { isForcedLightshowMode, type LightshowMode } from '../../core/lighting/basic-light';
import { defaultViewerSettings, loadViewerSettings, sanitizeViewerSettings } from '../../core/viewer-settings';
import { environmentCatalog } from '../../renderer/environment/environment-catalog';
import { useLightshowShowcase } from '../lightshow-showcase/use-lightshow-showcase';
import { EmbeddedRealtimeScoreTimeline, isEmbeddedRealtimeScoreMessage } from '../live/embedded-realtime-score-sync';
import { LudusPlayState } from '../live/generated/proto/scoresaber/live/v1/common_pb';
import { replayLightshowMode } from '../live/live-replay';
import type { LiveStatus, LiveTarget } from '../live/live-types';
import { LiveViewerPanel } from '../live/live-viewer-panel';
import { useLiveExperience } from '../live/use-live-experience';
import { useMapPoolShowcase } from '../map-pool-showcase/use-map-pool-showcase';
import { ReplayPlayerCard } from '../replay/replay-player-card';
import { SettingsDrawer } from '../settings/settings-drawer';
import { useWatchPartyExperience } from '../watch-party/use-watch-party-experience';
import { WatchPartyControls } from '../watch-party/watch-party-controls';
import { WatchPartyPanel } from '../watch-party/watch-party-panel';
import {
  applyWatchPartyViewerSettings,
  encodeWatchPartyViewerSettings,
  parseWatchPartyViewerSettings,
  preserveLocalWatchPartyViewerSettings,
} from '../watch-party/watch-party-viewer-settings';
import { MapSummaryCard } from './components/map-summary-card';
import { ReplayOrthoOverlay } from './components/replay-ortho-overlay';
import { SourcePicker } from './components/source-picker';
import { ViewerActions } from './components/viewer-actions';
import { ViewerOverlay } from './components/viewer-overlay';
import { buildTimelineMarkers } from './timeline-markers';
import { TransportControls } from './transport/transport-controls';
import { useSongTransport } from './use-song-transport';
import { useViewerControls } from './use-viewer-controls';
import { useViewerSession } from './use-viewer-session';
import { useViewerShare } from './use-viewer-share';
import { useViewerSources } from './use-viewer-sources';
import { dynamicLocationValues, dynamicSettingsPatch, initialViewerSettings } from './viewer-embed-settings';
import type { MultiviewTileOptions } from './viewer-embed-types';
import {
  hasExternallyConfiguredSettings,
  hasConfiguredPoolShowcase,
  hasConfiguredShowcase,
  renderPerformanceForSearch,
  replaceRenderPerformance,
  updateRenderPerformance,
} from './viewer-search';
import { quantizedBeatAt } from './viewer-timeline';
import type { ViewerPanel } from './viewer-types';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { cn } from '@/lib/utils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceDynamicLocation(values: Record<string, unknown>) {
  const url = new URL(window.location.href);
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey === 'screenDisplacementEffects' ? 'screenDisplacement' : rawKey;
    if (value === undefined || value === null || value === '') url.searchParams.delete(key);
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      url.searchParams.set(key, String(value));
    }
  }
  window.history.replaceState(window.history.state, '', url);
}

export type { MultiviewPlaybackSnapshot } from './viewer-embed-types';

interface ViewerShellProps {
  multiview?: MultiviewTileOptions;
}

export function ViewerShell({ multiview }: ViewerShellProps = {}) {
  const router = useRouter();
  const routeSearch = useSearch({ from: '/' });
  // Multiview tiles use the broadcast preset unless their settings say qualityPreset ""
  const multiviewBroadcast = multiview?.settings?.qualityPreset !== '';
  const search =
    multiview === undefined
      ? routeSearch
      : {
          ...routeSearch,
          ...multiview.settings,
          hideUI: true as const,
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
  const t = useTranslations('viewer');
  const commonT = useTranslations('common');
  const partyT = useTranslations('watchParty');
  const partyActive = search.party !== undefined;
  const hideUI = search.hideUI === true;
  const taLiveSource = search.liveSource === 'ta' || search.liveSource === 'cocu';
  const configuredShowcase = hasConfiguredShowcase(search);
  const configuredPoolShowcase = hasConfiguredPoolShowcase(search);
  const configuredSequence = configuredShowcase || configuredPoolShowcase;
  const isolatedSettings = search.isolatedSettings === true || multiview !== undefined;
  const embeddedSource =
    taLiveSource || search.previewSource !== undefined || search.showcase === true || search.poolShowcase === true;
  const externallyConfiguredSettings =
    embeddedSource || multiview !== undefined || hasExternallyConfiguredSettings(search);
  const [performance, setPerformance] = useState(() => renderPerformanceForSearch(search));
  const [settings, setSettings] = useState(() => {
    // Isolated embeds must be deterministic: defaults first, then URL/message
    // overrides. They neither read from nor write to another viewer's settings.
    return initialViewerSettings(search, isolatedSettings ? defaultViewerSettings() : loadViewerSettings());
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [partyViewerSettingsJson, setPartyViewerSettingsJson] = useState<string | null>(null);
  const partyViewerSettings = useMemo(
    () => (partyViewerSettingsJson === null ? null : parseWatchPartyViewerSettings(partyViewerSettingsJson)),
    [partyViewerSettingsJson],
  );
  const effectiveSettings = useMemo(
    () =>
      partyActive && partyViewerSettings !== null
        ? applyWatchPartyViewerSettings(settings, partyViewerSettings)
        : settings,
    [partyActive, partyViewerSettings, settings],
  );
  const effectiveSettingsRef = useRef(effectiveSettings);
  effectiveSettingsRef.current = effectiveSettings;
  const [error, setError] = useState('');
  const [embeddedLights, setEmbeddedLights] = useState<LightshowMode | null>(null);
  const presetLights =
    search.showcase === true ? 'full-lightshow' : search.qualityPreset === 'broadcast' ? 'static' : null;
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
  const [activePanel, setActivePanel] = useState<ViewerPanel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [liveChatOpen, setLiveChatOpen] = useState(
    () => !settings.liveChatCollapsed && window.matchMedia('(min-width: 40rem)').matches,
  );
  const [mobileMapCollapseRequest, setMobileMapCollapseRequest] = useState(0);
  const [mobileViewport, setMobileViewport] = useState({
    chatHeight: 'min(44dvh, 20.4rem)',
    centerY: '50dvh',
    keyboardInset: 0,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const liveChatInputRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const sources = useViewerSources({
    // TA and configured showcases own the map/replay lifecycle. Keeping generic
    // remote sources disabled also prevents hidden requests from competing with
    // those authoritative sources. Standalone showcase previews still use map=.
    remoteSourcesEnabled: !taLiveSource && !configuredSequence,
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
    hitScoresOnly: search.hitScoresOnly === true,
    lightBrightness: search.lightBrightness ?? 1,
    hidePlatform: search.hidePlatform === true,
    hideGameplayNotes: search.showcase === true,
    lightshowMode,
    lightshowModeRef,
    authoritativeLightshowMode: authoritativeLights,
    skipInitialMenuEnvironment:
      search.map !== undefined || search.scoreId !== undefined || search.scoreIdBL !== undefined,
    setActivePanel,
    setError,
    setLightshowMode,
    setSettings,
    persistedSettings: settings,
    settings: effectiveSettings,
    settingsRef: effectiveSettingsRef,
    sources,
    transport,
    performance,
    persistSettings: !isolatedSettings && !externallyConfiguredSettings,
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
      ...(multiviewBroadcast ? { qualityPreset: 'broadcast', maxFps: 60 } : {}),
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
  const liveActive = liveTarget !== null;
  const taLive = liveTarget?.source === 'ta' || liveTarget?.source === 'cocu';
  const remoteActive = liveActive || partyActive;
  useEffect(() => {
    if (!embeddedSource || multiview !== undefined) return;

    let lastSearch = '';
    function applySettingsFromLocation() {
      if (window.location.search === lastSearch) return;
      lastSearch = window.location.search;
      const values = dynamicLocationValues();
      setPerformance(replaceRenderPerformance(values));
      setSettings((current) => sanitizeViewerSettings({ ...current, ...dynamicSettingsPatch(values) }));
      const lights = [...new URLSearchParams(window.location.search)].find(
        ([key]) => key.toLowerCase() === 'lights',
      )?.[1];
      if (lights === 'full-lightshow' || lights === 'full' || lights === 'static' || lights === 'none') {
        setEmbeddedLights(lights);
        session.applyAuthoritativeLightshowMode(lights);
      } else if (search.showcase === true) {
        setEmbeddedLights('full-lightshow');
        session.applyAuthoritativeLightshowMode('full-lightshow');
      } else if (values.qualityPreset === 'broadcast') {
        setEmbeddedLights('static');
        session.applyAuthoritativeLightshowMode('static');
      }
    }

    applySettingsFromLocation();
    // A same-origin overlay can update the iframe URL with history.replaceState.
    // replaceState emits no browser event, so a small TA-only poll makes the
    // query parameter a live control without reloading the renderer or map.
    const interval = window.setInterval(applySettingsFromLocation, 200);
    window.addEventListener('popstate', applySettingsFromLocation);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('popstate', applySettingsFromLocation);
    };
  }, [embeddedSource, multiview !== undefined]);
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
    if (!embeddedSource || multiview !== undefined) return;

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
      replaceDynamicLocation({
        ...settingsPatch,
        ...performancePatch,
        ...(Number.isFinite(masterVolume) ? { masterVolume } : {}),
        ...(Number.isFinite(songVolume) ? { songVolume } : {}),
        ...(Number.isFinite(hitsoundVolume) ? { hitsoundVolume } : {}),
        ...(typeof data.lights === 'string' ? { lights: data.lights } : {}),
      });
      setPerformance((current) => updateRenderPerformance(current, performancePatch));
      setSettings((current) => {
        return sanitizeViewerSettings({
          ...current,
          ...dynamicSettingsPatch(settingsPatch),
          ...(Number.isFinite(masterVolume) ? { masterVolume } : {}),
          ...(Number.isFinite(songVolume) ? { songVolume } : {}),
          ...(Number.isFinite(hitsoundVolume) ? { hitsoundVolume } : {}),
        });
      });
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
  }, [embeddedSource, multiview !== undefined]);
  useLightshowShowcase({
    enabled: configuredShowcase,
    configValue: search.showcaseConfig,
    session,
    sources,
    transport,
  });
  const mapPoolShowcase = useMapPoolShowcase({
    enabled: configuredPoolShowcase,
    configValue: search.poolShowcaseConfig,
    session,
    sources,
    transport,
  });
  useEffect(() => {
    if (search.previewSource === undefined || !transport.ended || transport.duration <= 0) return;
    const requestedStart = search.previewStartSeconds ?? 0;
    transport.seek(requestedStart >= transport.duration ? 0 : requestedStart);
    transport.play({ autoplay: true });
  }, [search.previewSource, search.previewStartSeconds, transport.duration, transport.ended]);
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
  const party = useWatchPartyExperience({
    partyPlayerId: search.party ?? null,
    session,
    setError,
    sources,
    transport,
  });
  const partyIsHost = party.selfCapabilities?.host === true;
  useEffect(() => {
    if (!partyActive) return;
    const previewUrl = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
    if (previewUrl === undefined) return;
    const prefetch = document.createElement('link');
    prefetch.rel = 'prefetch';
    prefetch.as = 'image';
    prefetch.href = previewUrl;
    document.head.append(prefetch);
    return () => {
      prefetch.remove();
    };
  }, [partyActive, search.party]);
  useEffect(() => {
    const viewerSettings = party.serverState?.viewerSettings;
    if (!partyActive || viewerSettings?.schemaVersion !== 1) {
      setPartyViewerSettingsJson(null);
      return;
    }
    setPartyViewerSettingsJson(viewerSettings.json);
  }, [party.serverState?.viewerSettings, partyActive]);
  useEffect(() => {
    if (!partyActive || partyViewerSettings === null) return;
    session.applyAuthoritativeLightshowMode(partyViewerSettings.lightshowMode);
  }, [partyActive, partyViewerSettings?.lightshowMode]);
  useEffect(() => {
    if (!partyActive || !partyIsHost) return;
    const json = encodeWatchPartyViewerSettings(settings, lightshowMode);
    setPartyViewerSettingsJson(json);
    if (party.serverState?.viewerSettings?.schemaVersion === 1 && party.serverState.viewerSettings.json === json) {
      return;
    }
    const timeout = window.setTimeout(() => {
      party.setViewerSettings(json);
    }, 200);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [lightshowMode, party.serverState?.viewerSettings, partyActive, partyIsHost, party.setViewerSettings, settings]);
  const partyMapMatchesSource =
    party.serverState?.map !== undefined &&
    sources.mapIdentity?.hash.toLowerCase() === party.serverState.map.hash.toLowerCase();
  const showMapCard =
    sources.mapMeta !== null &&
    (!partyActive || (partyMapMatchesSource && (partyIsHost || party.serverState?.mapRevealed === true)));
  useEffect(() => {
    setLiveChatOpen(
      !taLive && !settingsRef.current.liveChatCollapsed && window.matchMedia('(min-width: 40rem)').matches,
    );
  }, [search.matchId, search.party, search.playerId, search.roomId, search.tournamentId, taLive]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const visualViewport: VisualViewport = viewport;
    let animationFrame = 0;

    function updateViewport() {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        const editing =
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement ||
          (activeElement instanceof HTMLElement && activeElement.isContentEditable);
        const occludedBottom = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
        const keyboardInset = editing && occludedBottom > 80 ? occludedBottom : 0;
        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const chatHeight = Math.min(visualViewport.height * 0.44, rootFontSize * 20.4);
        setMobileViewport({
          chatHeight: `${chatHeight}px`,
          centerY: `${visualViewport.offsetTop + visualViewport.height / 2}px`,
          keyboardInset,
        });
      });
    }

    updateViewport();
    visualViewport.addEventListener('resize', updateViewport);
    visualViewport.addEventListener('scroll', updateViewport);
    window.addEventListener('orientationchange', updateViewport);
    document.addEventListener('focusin', updateViewport);
    document.addEventListener('focusout', updateViewport);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      visualViewport.removeEventListener('resize', updateViewport);
      visualViewport.removeEventListener('scroll', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
      document.removeEventListener('focusin', updateViewport);
      document.removeEventListener('focusout', updateViewport);
    };
  }, []);
  useEffect(() => {
    if (!liveActive || taLive) return;
    function openChat(event: KeyboardEvent) {
      if (event.key !== 'F8') return;
      event.preventDefault();
      setChromeVisible(true);
      setLiveChatOpen(true);
      setSettings((current) => ({ ...current, liveChatCollapsed: false }));
      setMobileMapCollapseRequest((request) => request + 1);
      window.requestAnimationFrame(() => liveChatInputRef.current?.focus());
    }
    window.addEventListener('keydown', openChat, true);
    return () => {
      window.removeEventListener('keydown', openChat, true);
    };
  }, [liveActive, taLive]);
  function toggleHitsounds() {
    setSettings((current) => ({ ...current, hitsounds: !current.hitsounds }));
  }

  function toggleMasterMuted() {
    if (settingsRef.current.masterMuted) void transport.unlockAudio();
    setSettings((current) => ({ ...current, masterMuted: !current.masterMuted }));
  }

  function toggleSongMuted() {
    if (settingsRef.current.songMuted) void transport.unlockAudio();
    setSettings((current) => ({ ...current, songMuted: !current.songMuted }));
  }

  function toggleSettings(event: ReactMouseEvent<HTMLButtonElement>) {
    triggerRef.current = event.currentTarget;
    setActivePanel(null);
    setSettingsOpen((open) => !open);
  }

  useViewerControls({
    activePanel,
    autoHide: remoteActive ? false : settings.autoHide,
    beatStep: transport.beatStepNumerator / transport.beatStepDenominator,
    playing: transport.playing,
    transportReadOnly: remoteActive,
    setActivePanel,
    setChromeVisible,
    triggerRef,
    onSeekBeats: (beats) => {
      transport.seekBeats(beats, sources.songBpm);
    },
    onToggleHitsounds: toggleHitsounds,
    onTogglePlay: transport.togglePlay,
  });

  const beatStep = transport.beatStepNumerator / transport.beatStepDenominator;
  const displayBeat = quantizedBeatAt(transport.time, sources.songBpm, beatStep);
  const selectedDifficulty = useMemo(
    () => sources.rows.find((row) => row.key === session.selectedKey)?.difficulty ?? null,
    [session.selectedKey, sources.rows],
  );
  const replay = sources.replayRef.current;
  const replayNoteCount = replay?.notes.length ?? 0;
  const replayPauseCount = replay?.pauses.length ?? 0;
  const latestPauseDuration = replay?.pauses.at(-1)?.duration;
  const timelineMarkers = useMemo(
    () => buildTimelineMarkers(replay, selectedDifficulty, sources.songBpm, settings.showBookmarks),
    [
      latestPauseDuration,
      replay,
      replayNoteCount,
      replayPauseCount,
      selectedDifficulty,
      settings.showBookmarks,
      sources.songBpm,
    ],
  );
  const share = useViewerShare({
    beat: displayBeat,
    lightshowMode,
    liveTarget: liveTarget ?? undefined,
    mapIdentity: sources.mapIdentity,
    scoreId: sources.shareScoreId,
    scoreIdBL: sources.shareScoreIdBL,
    selectedDifficultyIndex: session.selectedDifficultyIndex,
    settings,
    sourceLink: sources.sourceLink,
    setError,
  });
  const liveInterruption =
    live.status === 'connecting' || live.status === 'reconnecting'
      ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: t('liveConnecting') }
      : live.status === 'loading'
        ? { icon: Download, iconClassName: '', label: t('liveDownloadingMap'), progress: sources.liveDownloadProgress }
        : live.status === 'buffering'
          ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: t('liveBuffering') }
          : live.playState === LudusPlayState.PAUSED || live.status === 'paused'
            ? { icon: Pause, iconClassName: 'fill-current', label: t('livePaused') }
            : live.playState === LudusPlayState.IN_MENUS
              ? { icon: Menu, iconClassName: '', label: t('liveInMenus') }
              : null;
  const partyInterruption = !partyActive
    ? null
    : party.status === 'connecting'
      ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: partyT('connecting') }
      : party.status === 'reconnecting'
        ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: partyT('reconnecting') }
        : party.status === 'loading' || party.hostMapLoading
          ? {
              icon: Download,
              iconClassName: '',
              label: partyT('downloadingMap'),
              progress: sources.liveDownloadProgress,
            }
          : !partyIsHost && party.serverState?.map === undefined
            ? { icon: UsersRound, iconClassName: '', label: partyT('waitingForHostMap') }
            : !partyIsHost && party.mapReady && party.serverState?.mapRevealed !== true
              ? { icon: UsersRound, iconClassName: '', label: partyT('waitingForHostStart') }
              : null;
  const sourcePickerVisible =
    !hideUI && sources.mapMeta === null && !remoteActive && !sources.sourceLoading && !session.environmentLoading;
  const playbackOverlay = remoteActive
    ? null
    : sources.sourceLoading
      ? {
          icon: Download,
          iconClassName: '',
          label:
            sources.sourceDownload?.kind === 'scoresaber' || sources.sourceDownload?.kind === 'replay'
              ? t('downloadingReplay')
              : t('liveDownloadingMap'),
          progress: sources.sourceDownload?.progress ?? null,
        }
      : session.difficultyLoading
        ? { icon: LoaderCircle, iconClassName: '', label: t('difficultyLoading') }
        : session.environmentLoading
          ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: t('environmentLoading') }
          : session.selectedKey !== '' && transport.ended
            ? {
                actionLabel: commonT('replay'),
                icon: RotateCcw,
                label: commonT('replay'),
                onAction: () => {
                  transport.togglePlay();
                },
              }
            : session.selectedKey !== '' && !transport.started
              ? {
                  actionLabel: commonT('play'),
                  icon: Play,
                  label: commonT('play'),
                  onAction: () => {
                    transport.togglePlay();
                  },
                }
              : null;
  const viewportStyle: CSSProperties &
    Record<
      '--live-keyboard-inset' | '--live-mobile-chat-height' | '--live-safe-area-bottom' | '--live-viewport-center-y',
      string
    > = {
    '--live-keyboard-inset': `${mobileViewport.keyboardInset}px`,
    '--live-mobile-chat-height': mobileViewport.chatHeight,
    '--live-safe-area-bottom': mobileViewport.keyboardInset > 0 ? '0px' : 'env(safe-area-inset-bottom)',
    '--live-viewport-center-y': mobileViewport.centerY,
  };
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

  if (multiview !== undefined) return null;
  return (
    <main
      className="relative size-full overflow-hidden bg-black [--live-sidebar-width:18rem]"
      style={viewportStyle}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!remoteActive) void sources.loadFiles([...event.dataTransfer.files]);
      }}
    >
      <div
        className={cn(
          'absolute inset-0 transition-[bottom] duration-300 ease-out',
          remoteActive &&
            !hideUI &&
            liveChatOpen &&
            'max-sm:bottom-[calc(var(--live-mobile-chat-height)+var(--live-safe-area-bottom)+var(--live-keyboard-inset))]',
        )}
      >
        <canvas
          ref={session.canvasRef}
          className={cn(
            'absolute inset-0 size-full transition-[filter,transform] duration-500',
            sourcePickerVisible && 'scale-[1.01] blur-[3px]',
            partyActive && !partyIsHost && !(party.mapReady && party.serverState?.mapRevealed === true) && 'invisible',
          )}
          onPointerDown={() => {
            setSettingsOpen(false);
          }}
          onWheel={(event) => {
            if (remoteActive || session.selectedKey === '' || event.deltaY === 0 || event.ctrlKey || event.metaKey)
              return;
            transport.seekBeats(Math.sign(event.deltaY) * beatStep, sources.songBpm);
          }}
        />
      </div>

      {configuredPoolShowcase && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 z-[25] bg-black transition-opacity duration-[1400ms] ease-in-out',
            mapPoolShowcase.visualFaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}

      {!hideUI &&
        settings.orthoCameraEnabled &&
        sources.replayRef.current !== null &&
        session.selectedKey !== '' &&
        !isForcedLightshowMode(lightshowMode) &&
        (!partyActive || (party.mapReady && (partyIsHost || party.serverState?.mapRevealed === true))) && (
          <ReplayOrthoOverlay
            overlayRef={session.orthoOverlayRef}
            view={settings.orthoCameraView}
            onViewChange={(orthoCameraView) => {
              setSettings((current) => ({ ...current, orthoCameraView }));
            }}
          />
        )}

      {hideUI &&
        taLive &&
        !(live.status === 'watching' && transport.playing && sources.mapMeta !== null && transport.duration > 0) && (
          <ViewerOverlay
            backdropBlur={false}
            className="!bg-black"
            icon={live.status === 'error' ? AlertCircle : LoaderCircle}
            iconClassName={live.status === 'error' || live.status === 'paused' ? '' : 'animate-spin'}
            label={
              live.status === 'error'
                ? error || 'Replay stream unavailable'
                : live.status === 'connecting'
                  ? 'Connecting to TournamentAssistant'
                  : live.status === 'reconnecting'
                    ? 'Reconnecting to TournamentAssistant'
                    : live.status === 'loading'
                      ? t('liveDownloadingMap')
                      : live.status === 'buffering'
                        ? 'Preparing replay stream'
                        : live.status === 'paused'
                          ? t('livePaused')
                          : 'Waiting for replay stream'
            }
            progress={live.status === 'loading' ? sources.liveDownloadProgress : undefined}
          />
        )}

      {!hideUI && liveActive && liveInterruption !== null && (
        <ViewerOverlay
          backdropBlur={false}
          className={cn(
            liveChatOpen &&
              'max-sm:bottom-[calc(var(--live-mobile-chat-height)+var(--live-safe-area-bottom)+var(--live-keyboard-inset))]',
          )}
          icon={liveInterruption.icon}
          iconClassName={liveInterruption.iconClassName}
          label={liveInterruption.label}
          progress={'progress' in liveInterruption ? liveInterruption.progress : undefined}
        />
      )}

      {partyInterruption !== null && (
        <ViewerOverlay
          backdropBlur={false}
          className={cn(
            'z-20',
            !partyIsHost && party.mapReady && party.serverState?.mapRevealed !== true && 'bg-black',
            liveChatOpen &&
              'max-sm:bottom-[calc(var(--live-mobile-chat-height)+var(--live-safe-area-bottom)+var(--live-keyboard-inset))]',
          )}
          icon={partyInterruption.icon}
          iconClassName={partyInterruption.iconClassName}
          label={partyInterruption.label}
          progress={'progress' in partyInterruption ? partyInterruption.progress : undefined}
        />
      )}

      {!hideUI && playbackOverlay !== null && (
        <ViewerOverlay
          {...playbackOverlay}
          className={'onAction' in playbackOverlay ? '!bottom-16 max-sm:!bottom-24' : undefined}
        />
      )}

      {!hideUI && !liveActive && transport.audioBlocked && (
        <Button
          className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full shadow-xl backdrop-blur-xl max-sm:bottom-24"
          variant="outline"
          aria-label={t('clickToUnmute')}
          onClick={() => {
            void (partyActive ? party.unlockAudio() : transport.unlockAudio());
          }}
        >
          <Volume2 />
          {t('clickToUnmute')}
        </Button>
      )}

      {!hideUI && remoteActive && liveChatOpen && (
        <div
          className="fixed inset-x-0 top-0 bottom-[calc(var(--live-mobile-chat-height)+var(--live-safe-area-bottom)+var(--live-keyboard-inset))] z-20 hidden max-sm:block"
          aria-hidden="true"
          onPointerDown={() => {
            setLiveChatOpen(false);
            setSettings((current) => ({ ...current, liveChatCollapsed: true }));
          }}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".dat,.bsor,.json,.zip,.ogg,.egg,.wav,.mp3"
        onChange={(event) => {
          void sources.loadFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = '';
        }}
      />

      <SourcePicker
        choices={sources.sourceChoices}
        input={sources.sourceInput}
        visible={sourcePickerVisible}
        onChoose={(choice) => {
          sources.loadLookup(choice);
        }}
        onAboutClick={() => {
          setActivePanel('about');
        }}
        onInputChange={sources.setSourceInput}
        onOpenFiles={() => {
          fileInputRef.current?.click();
        }}
        onSubmit={(source) => {
          sources.loadSource(source);
        }}
      />

      {!hideUI && (showMapCard || remoteActive) && (
        <div
          className={cn(
            'fixed left-3 top-3 z-30 flex max-h-[calc(100dvh-1.5rem)] flex-col items-start gap-2 transition duration-200 max-sm:left-2 max-sm:top-2 max-sm:max-h-[calc(100dvh-1rem)]',
            remoteActive &&
              'h-[calc(100dvh-1.5rem)] max-sm:!left-0 max-sm:!top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:gap-0',
            !chromeVisible &&
              (!showMapCard || !settings.keepMapInfoVisible) &&
              'pointer-events-none -translate-y-2 opacity-0',
          )}
        >
          {(showMapCard || (partyActive && partyIsHost)) && (
            <div
              className={cn(
                partyActive && 'flex shrink-0 items-start gap-2 max-sm:w-screen max-sm:flex-col max-sm:gap-0',
              )}
            >
              {showMapCard && sources.mapMeta !== null && (
                <MapSummaryCard
                  difficultyReadOnly={partyActive}
                  dockedOnMobile={remoteActive}
                  mobileCollapseRequest={mobileMapCollapseRequest}
                  showBackButton={!partyActive}
                  title={sources.mapMeta.title}
                  subtitle={sources.mapMeta.subtitle}
                  author={sources.mapMeta.author}
                  mapper={sources.mapMeta.mapper}
                  coverUrl={sources.coverUrl}
                  mapKey={sources.mapIdentity?.key ?? null}
                  mapHash={sources.mapIdentity?.hash ?? null}
                  leaderboardUrl={session.leaderboardUrl}
                  leaderboardPlatform={session.leaderboardPlatform}
                  options={session.difficultyOptions}
                  selectedKey={session.selectedKey}
                  settingsOpen={settingsOpen}
                  onSelectDifficulty={(key) => {
                    const row = sources.rows.find((candidate) => candidate.key === key);
                    if (row !== undefined) void session.selectDifficulty(row);
                  }}
                  onBack={() => {
                    void router.navigate({ to: '/', search: {}, replace: true, reloadDocument: true });
                  }}
                  onCopyError={() => {
                    setError(t('errors.copyMapInfo'));
                  }}
                  onSettingsClick={toggleSettings}
                />
              )}
              {partyActive && partyIsHost && (
                <div className={chromeVisible ? 'contents' : 'hidden'}>
                  <WatchPartyControls party={party} />
                </div>
              )}
            </div>
          )}
          <div className={chromeVisible ? 'contents' : 'hidden'}>
            {liveActive ? (
              <LiveViewerPanel
                chatEnabled={!taLive}
                chatInputRef={liveChatInputRef}
                chatOpen={liveChatOpen}
                live={live}
                playerId={liveTarget.playerId}
                onChatOpenChange={(open) => {
                  setLiveChatOpen(open);
                  setSettings((current) => ({ ...current, liveChatCollapsed: !open }));
                  if (open) setMobileMapCollapseRequest((request) => request + 1);
                }}
              />
            ) : partyActive ? (
              <WatchPartyPanel
                chatInputRef={liveChatInputRef}
                chatOpen={liveChatOpen}
                party={party}
                onLeave={() => {
                  void router.navigate({ to: '/', search: {}, replace: true });
                }}
                onChatOpenChange={(open) => {
                  setLiveChatOpen(open);
                  setSettings((current) => ({ ...current, liveChatCollapsed: !open }));
                  if (open) setMobileMapCollapseRequest((request) => request + 1);
                }}
              />
            ) : (
              sources.replayPlayer !== null && (
                <ReplayPlayerCard
                  player={sources.replayPlayer}
                  platform={
                    sources.shareScoreIdBL !== null ||
                    sources.replayRef.current?.metadata.version.includes('BeatLeader')
                      ? 'beatleader'
                      : 'scoresaber'
                  }
                />
              )
            )}
          </div>
        </div>
      )}

      {!hideUI && (
        <ViewerActions
          aboutOpen={activePanel === 'about'}
          aboutTriggerVisible={!sourcePickerVisible}
          chromeVisible={chromeVisible}
          hasMap={showMapCard}
          shareEnabled={!partyActive}
          settingsOpen={settingsOpen}
          shareCategories={share.shareCategories}
          shareIncludeTimecode={share.includeTimecode}
          shareOpen={activePanel === 'share'}
          shareUrl={share.shareUrl}
          onAboutOpenChange={(open) => {
            setActivePanel(open ? 'about' : null);
          }}
          onCopyShare={share.copyShareLink}
          onSettingsClick={toggleSettings}
          onShareCategoriesChange={share.setShareCategories}
          onShareIncludeTimecodeChange={share.setIncludeTimecode}
          onShareOpenChange={(open) => {
            setActivePanel(open ? 'share' : null);
          }}
        />
      )}

      {!hideUI &&
        session.selectedKey !== '' &&
        (!partyActive || (party.mapReady && (partyIsHost || party.serverState?.mapRevealed === true))) && (
          <TransportControls
            mode={partyActive ? 'party' : liveActive ? 'live' : 'playback'}
            visible={chromeVisible}
            playing={transport.playing}
            ended={transport.ended}
            time={transport.time}
            duration={transport.duration}
            songBpm={sources.songBpm}
            beatStepNumerator={transport.beatStepNumerator}
            beatStepDenominator={transport.beatStepDenominator}
            timelineShareUrl={share.timelineShareUrl}
            timelineCopied={share.timelineCopied}
            panel={
              activePanel === 'speed' ||
              activePanel === 'lights' ||
              activePanel === 'camera' ||
              activePanel === 'volume'
                ? activePanel
                : null
            }
            playbackRate={transport.playbackRate}
            lightshowMode={lightshowMode}
            lightshowReadOnly={partyActive && !partyIsHost}
            replayCamera={settings.replayCamera}
            orthoCameraEnabled={settings.orthoCameraEnabled}
            hasReplay={sources.replayRef.current !== null}
            songMuted={settings.songMuted}
            masterMuted={settings.masterMuted}
            masterVolume={settings.masterVolume}
            songVolume={settings.songVolume}
            hitsounds={settings.hitsounds}
            hitsoundVolume={settings.hitsoundVolume}
            reverseTimelineScroll={settings.reverseTimelineScroll}
            markers={timelineMarkers}
            onTogglePlay={() => {
              transport.togglePlay();
            }}
            onSeek={transport.seek}
            onSeekBeats={(beats) => {
              transport.seekBeats(beats, sources.songBpm);
            }}
            onNumeratorChange={transport.setBeatStepNumerator}
            onDenominatorChange={transport.setBeatStepDenominator}
            onCopyTimeline={(target) => {
              void share.copyTimelineShareLink(target);
            }}
            onPanelOpenChange={(panel, open) => {
              setActivePanel((current) => (open ? panel : current === panel ? null : current));
            }}
            onPlaybackRateChange={(rate) => {
              transport.setPlaybackRate(rate);
            }}
            onLightshowModeChange={session.changeLightshowMode}
            onReplayCameraChange={(replayCamera) => {
              setSettings({ ...settings, replayCamera });
            }}
            onOrthoCameraEnabledChange={(orthoCameraEnabled) => {
              setSettings((current) => ({ ...current, orthoCameraEnabled }));
            }}
            onMasterVolumeChange={(masterVolume) => {
              if (settingsRef.current.masterVolume === 0 && masterVolume > 0) void transport.unlockAudio();
              setSettings((current) => ({ ...current, masterVolume }));
            }}
            onSongVolumeChange={(songVolume) => {
              if (settingsRef.current.songVolume === 0 && songVolume > 0) void transport.unlockAudio();
              setSettings((current) => ({ ...current, songVolume }));
            }}
            onHitsoundVolumeChange={(hitsoundVolume) => {
              setSettings((current) => ({ ...current, hitsoundVolume }));
            }}
            onToggleMasterMuted={toggleMasterMuted}
            onToggleSongMuted={toggleSongMuted}
            onToggleHitsounds={toggleHitsounds}
          />
        )}

      {!hideUI && error !== '' && (
        <Alert
          className="fixed bottom-20 left-1/2 z-50 w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2"
          aria-live="assertive"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="text-destructive size-4 shrink-0" />
            {error}
          </span>
          {partyActive && party.canRetryMap && (
            <Button variant="outline" size="sm" onClick={party.retryMap}>
              {partyT('retry')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('dismissError')}
            onClick={() => {
              setError('');
            }}
          >
            <X />
          </Button>
        </Alert>
      )}
      {!hideUI && (
        <SettingsDrawer
          open={settingsOpen}
          settings={partyActive && !partyIsHost ? effectiveSettings : settings}
          environments={environmentCatalog}
          hasReplay={sources.replayRef.current !== null}
          isMapPreview={session.selectedKey !== '' && sources.replayRef.current === null}
          onChange={(nextSettings) => {
            setSettings((current) =>
              partyActive && !partyIsHost ? preserveLocalWatchPartyViewerSettings(current, nextSettings) : nextSettings,
            );
          }}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
    </main>
  );
}
