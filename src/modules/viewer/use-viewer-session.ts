import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { useTranslations } from 'use-intl';

import { songBpmTimeToSeconds } from '../../core/beatmap/bpm';
import { difficultyRank } from '../../core/beatmap/info';
import { buildHitsoundEvents } from '../../core/clock/hitsounds';
import type { LightshowMode } from '../../core/lighting/basic-light';
import { applyReplayHeightEvents, buildMapRenderData } from '../../core/placement/map-render-data';
import { hitScoreVisualizerForSettings } from '../../core/replay/replay-display';
import type { ReplayHeightEvent, ReplayNoteEvent } from '../../core/replay/types';
import { colorOverride, environmentForSettings, type ViewerSettings } from '../../core/viewer-settings';
import { resolveEnvironmentId } from '../../renderer/environment/environment-catalog';
import type { MultiviewRendererHost } from '../../renderer/multiview-renderer-host';
import type { RenderPerformanceOptions } from '../../renderer/render-performance';
import type { MultiviewTimeline } from '../multiview/multiview-timeline';
import { replayMapRenderOptions } from './replay-map-render-options';
import type { useSongTransport } from './use-song-transport';
import { useViewerRenderer } from './use-viewer-renderer';
import { useViewerSettingsSync } from './use-viewer-settings-sync';
import type { useViewerSources } from './use-viewer-sources';
import type { ActiveSelection, DifficultyRow, ViewerPanel } from './viewer-types';

type SongTransport = ReturnType<typeof useSongTransport>;
type ViewerSources = ReturnType<typeof useViewerSources>;

interface ViewerSessionOptions {
  disableGameUI: boolean;
  /** Game UI shows only the hit-score visualizer. */
  hitScoresOnly?: boolean;
  /** 0-1 multiplier for every map light. */
  lightBrightness?: number;
  hidePlatform: boolean;
  hideGameplayNotes: boolean;
  lightshowMode: LightshowMode;
  lightshowModeRef: RefObject<LightshowMode>;
  authoritativeLightshowMode?: LightshowMode | null;
  skipInitialMenuEnvironment: boolean;
  setActivePanel: Dispatch<SetStateAction<ViewerPanel>>;
  setError: (message: string) => void;
  setLightshowMode: Dispatch<SetStateAction<LightshowMode>>;
  setSettings: Dispatch<SetStateAction<ViewerSettings>>;
  persistedSettings: ViewerSettings;
  settings: ViewerSettings;
  settingsRef: RefObject<ViewerSettings>;
  sources: Pick<
    ViewerSources,
    | 'audioDataRef'
    | 'pendingSharedViewRef'
    | 'replayRef'
    | 'rows'
    | 'scoreSaberLeaderboards'
    | 'beatLeaderLeaderboards'
    | 'songBpm'
    | 'shareScoreIdBL'
  >;
  transport: Pick<SongTransport, 'clear' | 'clockRef' | 'load' | 'play' | 'seek' | 'setHitsoundEvents'>;
  performance: RenderPerformanceOptions;
  persistSettings?: boolean;
  sharedRenderer?: { host: MultiviewRendererHost; id: string };
  sharedTimeline?: { timeline: MultiviewTimeline; id: string };
}

export function useViewerSession({
  disableGameUI,
  hitScoresOnly = false,
  lightBrightness = 1,
  hidePlatform,
  hideGameplayNotes,
  lightshowMode,
  lightshowModeRef,
  authoritativeLightshowMode = null,
  skipInitialMenuEnvironment,
  setActivePanel,
  setError,
  setLightshowMode,
  setSettings,
  persistedSettings,
  settings,
  settingsRef,
  sources,
  transport,
  performance,
  persistSettings = true,
  sharedRenderer,
  sharedTimeline,
}: ViewerSessionOptions) {
  const t = useTranslations('viewer');
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  const selectionRequestRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const [difficultyLoading, setDifficultyLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const { canvasRef, environmentLoading, orthoOverlayRef, viewerReady, viewerRef } = useViewerRenderer({
    activeSelectionRef,
    clockRef: transport.clockRef,
    lightshowModeRef,
    replayRef: sources.replayRef,
    settings,
    settingsRef,
    performance,
    skipInitialMenuEnvironment,
    setError,
    sharedRenderer,
    sharedTimeline,
  });

  useEffect(() => {
    viewerRef.current?.view.setGameUIEnabled(!disableGameUI);
  }, [disableGameUI, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setHitScoresOnly(hitScoresOnly);
  }, [hitScoresOnly, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setLightBrightness(lightBrightness);
  }, [lightBrightness, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setPlayerPlatformVisible(!hidePlatform);
  }, [hidePlatform, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setGameplayNotesVisible(!hideGameplayNotes);
  }, [hideGameplayNotes, viewerReady]);

  const { reportEnvironmentError } = useViewerSettingsSync({
    viewerRef,
    activeSelectionRef,
    replayRef: sources.replayRef,
    lightshowModeRef,
    authoritativeLightshowMode,
    skipInitialMenuEnvironment,
    setError,
    setLightshowMode,
    persistedSettings,
    settings,
    settingsRef,
    persistSettings,
  });

  async function selectDifficulty(row: DifficultyRow, initialBeat = 0) {
    const requestId = ++selectionRequestRef.current;
    setDifficultyLoading(false);
    const viewer = viewerRef.current;
    if (
      viewer === null ||
      row.difficulty === undefined ||
      row.infoDifficulty === undefined ||
      row.environmentId === undefined
    )
      return;
    const mapEnvironmentId = row.environmentId;
    const environmentId = resolveEnvironmentId(
      environmentForSettings(
        settings,
        mapEnvironmentId,
        row.replayEnvironmentId,
        row.infoDifficulty.usesChromaOrNoodle,
      ),
    );
    setError('');
    if (sources.replayRef.current !== null && row.replayMatch !== true) {
      setError(t('errors.selectReplayDifficulty'));
      return;
    }

    setDifficultyLoading(true);
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    if (requestId !== selectionRequestRef.current) return;

    const data = buildMapRenderData(
      row.difficulty,
      replayMapRenderOptions(
        row.infoDifficulty,
        row.legacyNoodleV2Semantics,
        sources.songBpm,
        sources.replayRef.current,
      ),
    );
    const hitsoundEvents = buildHitsoundEvents([...data.notes, ...data.chainLinks], sources.songBpm);
    const replayEnd = sources.replayRef.current?.poses.at(-1)?.time ?? 0;
    const fallbackDuration = Math.max(songBpmTimeToSeconds(data.endBeat, sources.songBpm) + 1, replayEnd);
    const clockPromise =
      transport.clockRef.current === null
        ? transport.load({
            audioEnabled: settings.masterVolume > 0,
            audioData: sources.audioDataRef.current,
            fallbackDuration,
            hitsoundEvents,
            onAudioDecodeError() {
              setError(t('errors.audioDecode'));
            },
            shouldCommit() {
              return requestId === selectionRequestRef.current;
            },
            songBpm: sources.songBpm,
            volume: settings.masterMuted || settings.songMuted ? 0 : settings.masterVolume * settings.songVolume,
          })
        : null;
    const environmentResult = await viewer.view.setEnvironment(environmentId, data.chromaEnvironment);
    if (environmentResult.isErr()) {
      if (requestId >= selectionGenerationRef.current) reportEnvironmentError(environmentResult.error);
      if (requestId === selectionRequestRef.current) {
        if (clockPromise !== null) transport.clear();
        setDifficultyLoading(false);
      }
      return;
    }
    if (requestId < selectionGenerationRef.current) return;
    selectionGenerationRef.current = requestId;
    const generation = requestId;
    viewer.view.setLightshowMode(lightshowModeRef.current);

    activeSelectionRef.current = {
      data,
      environmentId,
      mapEnvironmentId,
      replayEnvironmentId: row.replayEnvironmentId,
      usesChromaOrNoodle: row.infoDifficulty.usesChromaOrNoodle,
      mapColorScheme: row.colorScheme,
    };

    const currentReplayHeights = sources.replayRef.current?.heights ?? [];
    applyReplayHeightEvents(data, currentReplayHeights.slice(data.replayHeights.length));
    viewer.view.setBeatSource(() => initialBeat);
    viewer.view.setMap(data, colorOverride(settings, row.colorScheme, sources.replayRef.current?.metadata));
    viewer.view.setReplay(
      sources.replayRef.current,
      hitScoreVisualizerForSettings(settings, sources.replayRef.current),
    );
    viewer.view.setReplayCameraSettings(settings);
    setActivePanel(null);

    let clock = transport.clockRef.current;
    if (clockPromise !== null) {
      clock = await clockPromise;
    } else {
      transport.setHitsoundEvents(hitsoundEvents);
    }
    if (clock === null || generation !== selectionGenerationRef.current) {
      if (requestId === selectionRequestRef.current) setDifficultyLoading(false);
      return;
    }

    viewer.view.setSongDuration(clock.duration);
    viewer.view.setBeatSource(
      // Render from the POV's continuous clock. The multiview timeline is an
      // observer used for rare drift correction; its 100 ms status snapshots
      // must never become the per-frame animation clock.
      () => transport.clockRef.current?.currentBeat() ?? sharedTimeline?.timeline.beatFor(sharedTimeline.id) ?? 0,
    );
    setSelectedKey(row.key);
    if (requestId === selectionRequestRef.current) setDifficultyLoading(false);
    return true;
  }

  async function applyPendingView(row: DifficultyRow, beat: number | undefined, startSeconds?: number) {
    await selectDifficulty(row, beat);
    const clock = transport.clockRef.current;
    if (clock === null) return;
    const requested = startSeconds ?? songBpmTimeToSeconds(beat ?? 0, sources.songBpm);
    transport.seek(requested >= clock.duration ? 0 : requested);
  }

  useEffect(() => {
    const pending = sources.pendingSharedViewRef.current;
    if (!viewerReady || pending === null || sources.rows.length === 0 || sources.songBpm <= 0) return;
    const indexedRow = pending.difficultyIndex === undefined ? undefined : sources.rows[pending.difficultyIndex];
    const requestedCharacteristic = pending.characteristic?.toLowerCase();
    const requestedRow = sources.rows.find(
      (candidate) =>
        candidate.infoDifficulty !== undefined &&
        (pending.difficultyRank === undefined ||
          difficultyRank(candidate.infoDifficulty.difficulty) === pending.difficultyRank) &&
        (requestedCharacteristic === undefined ||
          candidate.infoDifficulty.characteristic.toLowerCase() === requestedCharacteristic ||
          `solo${candidate.infoDifficulty.characteristic.toLowerCase()}` === requestedCharacteristic),
    );
    const row =
      (requestedRow?.difficulty === undefined ? undefined : requestedRow) ??
      (indexedRow?.difficulty === undefined ? undefined : indexedRow) ??
      sources.rows.find((candidate) => sources.replayRef.current !== null && candidate.replayMatch === true) ??
      sources.rows.find((candidate) => candidate.difficulty !== undefined);
    if (row === undefined) return;
    sources.pendingSharedViewRef.current = null;
    void applyPendingView(row, pending.beat, pending.startSeconds).then(() => {
      if (pending.autoplay === true) transport.play({ autoplay: true });
    });
  }, [sources.rows, sources.songBpm, viewerReady]);

  function clearViewer() {
    selectionGenerationRef.current = ++selectionRequestRef.current;
    activeSelectionRef.current = null;
    setDifficultyLoading(false);
    setSelectedKey('');
    viewerRef.current?.view.clear();
  }

  function clearMapSelection() {
    setSelectedKey('');
  }

  function cycleLights() {
    const modes: LightshowMode[] = ['full-lightshow', 'full', 'static', 'none'];
    const next = modes[(modes.indexOf(lightshowMode) + 1) % modes.length] ?? 'full';
    changeLightshowMode(next);
  }

  function changeLightshowMode(mode: LightshowMode, updateSettings = true) {
    lightshowModeRef.current = mode;
    setLightshowMode(mode);
    viewerRef.current?.view.setLightshowMode(mode);
    if (updateSettings && mode !== 'none') {
      setSettings((current) => ({ ...current, staticLights: mode === 'static' }));
    }
  }

  function applyAuthoritativeLightshowMode(mode: LightshowMode) {
    changeLightshowMode(mode, false);
  }

  function cycleCamera() {
    if (sources.replayRef.current === null) return;
    const modes: ViewerSettings['replayCamera'][] = ['static', 'follow', 'first-person'];
    const next = modes[(modes.indexOf(settings.replayCamera) + 1) % modes.length] ?? 'static';
    setSettings((current) => ({ ...current, replayCamera: next }));
  }

  function appendLiveReplayNoteEvents(events: ReplayNoteEvent[]) {
    viewerRef.current?.view.appendReplayNoteEvents(events);
  }

  function appendLiveReplayHeightEvents(events: ReplayHeightEvent[]) {
    viewerRef.current?.view.appendReplayHeightEvents(events);
  }

  function refreshLiveReplayDisplay() {
    const view = viewerRef.current?.view;
    if (view === undefined) return;
    const replay = sources.replayRef.current;
    const currentSettings = settingsRef.current;
    view.setHitScoreVisualizer(hitScoreVisualizerForSettings(currentSettings, replay));
    const active = activeSelectionRef.current;
    if (active !== null) view.refreshMapColors(colorOverride(currentSettings, active.mapColorScheme, replay?.metadata));
  }

  const difficultyOptions = sources.rows.map((row) => ({
    key: row.key,
    label: row.label,
    disabled: row.difficulty === undefined || (sources.replayRef.current !== null && row.replayMatch !== true),
    difficulty: row.infoDifficulty?.difficulty ?? '',
  }));
  const selectedDifficultyIndex = sources.rows.findIndex((row) => row.key === selectedKey);
  const selectedRow = sources.rows[selectedDifficultyIndex];
  const selectedCharacteristic = selectedRow?.infoDifficulty?.characteristic;
  const selectedGameMode =
    selectedCharacteristic === undefined
      ? null
      : selectedCharacteristic.startsWith('Solo')
        ? selectedCharacteristic
        : `Solo${selectedCharacteristic}`;
  const isBeatLeaderReplay =
    sources.shareScoreIdBL !== null || sources.replayRef.current?.metadata.version.includes('BeatLeader') === true;
  const leaderboardPlatform: 'scoresaber' | 'beatleader' = isBeatLeaderReplay ? 'beatleader' : 'scoresaber';
  const leaderboard =
    selectedRow?.infoDifficulty === undefined || selectedGameMode === null
      ? undefined
      : (isBeatLeaderReplay ? sources.beatLeaderLeaderboards : sources.scoreSaberLeaderboards).find(
          (candidate) =>
            candidate.difficulty === difficultyRank(selectedRow.infoDifficulty?.difficulty ?? '') &&
            candidate.gameMode.toLowerCase() === selectedGameMode.toLowerCase(),
        );
  const leaderboardUrl =
    leaderboard === undefined
      ? null
      : isBeatLeaderReplay
        ? `https://beatleader.com/leaderboard/global/${leaderboard.id}`
        : `https://scoresaber.com/leaderboard/${leaderboard.id}`;

  return {
    canvasRef,
    appendLiveReplayHeightEvents,
    appendLiveReplayNoteEvents,
    refreshLiveReplayDisplay,
    applyAuthoritativeLightshowMode,
    changeLightshowMode,
    clearMapSelection,
    clearViewer,
    cycleCamera,
    cycleLights,
    difficultyOptions,
    difficultyLoading,
    environmentLoading,
    leaderboardUrl,
    leaderboardPlatform,
    orthoOverlayRef,
    selectDifficulty,
    selectedDifficultyIndex,
    selectedKey,
    viewerReady,
  };
}
