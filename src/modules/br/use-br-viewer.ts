import { useEffect, useMemo, useRef, useState } from 'react';

import { Result } from 'better-result';
import { useTranslations } from 'use-intl';

import { songBpmTimeToSeconds } from '../../core/beatmap/bpm';
import { BeatmapParser } from '../../core/beatmap/worker/client';
import { buildHitsoundEvents } from '../../core/clock/hitsounds';
import type { SongClock } from '../../core/clock/song-clock';
import { isForcedLightshowMode, type LightshowMode } from '../../core/lighting/basic-light';
import { buildMultiReplayMapRenderData } from '../../core/placement/map-render-data';
import { playerColors } from '../../core/player-colors';
import { convertLegacyScoreSaberReplay } from '../../core/replay/legacy-scoresaber';
import { mirrorLeftHandedReplay } from '../../core/replay/mirror-replay';
import { hitScoreVisualizerForSettings } from '../../core/replay/replay-display';
import { buildReplayScoreTimeline, type ReplayScoreTimeline } from '../../core/replay/scoring';
import type { Replay } from '../../core/replay/types';
import { colorOverride, environmentForSettings, loadViewerSettings } from '../../core/viewer-settings';
import { resolveEnvironmentId } from '../../renderer/environment/environment-catalog';
import type { ReplayPlayerView } from '../../renderer/map-view';
import { DEFAULT_RENDER_PERFORMANCE } from '../../renderer/render-performance';
import { parseMapPackage } from '../viewer/parse-map-package';
import { replayMapRenderOptions } from '../viewer/replay-map-render-options';
import { useSongTransport } from '../viewer/use-song-transport';
import { useViewerRenderer } from '../viewer/use-viewer-renderer';
import { useViewerSettingsSync } from '../viewer/use-viewer-settings-sync';
import type { ActiveSelection, MapMeta } from '../viewer/viewer-types';
import type { BrSession } from './br-load';
import {
  brPlayerKeys,
  brPlayerStyle,
  DEFAULT_BR_PLAYER_OVERRIDES,
  loadBrSettings,
  saveBrSettings,
} from './br-settings';
import { useBrPlayerNames } from './use-br-player-names';

// The parsed map of a session. It outlives renderer rebuilds (graphics quality), which only show it again.
interface LoadedBrMap {
  selection: Omit<ActiveSelection, 'environmentId'>;
  clock: Promise<SongClock | null>;
}

/**
 * Plays every replay of a Battle Royale session on one map, on one song clock. Replays are mirrored to right-handed
 * first; the first player's play settings shape the map and a note ends at the earliest cut by any player. Uses and
 * saves the viewer's settings exactly like the single-replay viewer.
 */
export function useBrViewer(session: BrSession) {
  const t = useTranslations('viewer');
  const [settings, setSettings] = useState(() => loadViewerSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [lightshowMode, setLightshowMode] = useState<LightshowMode>(settings.staticLights ? 'static' : 'full');
  const lightshowModeRef = useRef(lightshowMode);
  const [error, setError] = useState('');
  const [mapMeta, setMapMeta] = useState<MapMeta | null>(null);
  const [songBpm, setSongBpm] = useState(0);
  const [timelines, setTimelines] = useState<ReplayScoreTimeline[] | null>(null);
  const [loaded, setLoaded] = useState<LoadedBrMap | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  // The ortho main camera is a Battle Royale choice only: it stays out of the saved settings, which other pages read
  const [mainOrtho, setMainOrtho] = useState(false);
  // Ortho main camera, HUD and per-player overrides, in their own store so `/` never sees them
  const [brSettings, setBrSettings] = useState(loadBrSettings);
  const focusedIndexRef = useRef(focusedIndex);
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  // The followed player's replay: the "prefer replay" settings (colours, hit score profile) read it
  const replayRef = useRef<Replay | null>(null);
  const transport = useSongTransport({ lightshowModeRef, settings, settingsRef });
  const { canvasRef, environmentLoading, orthoOverlayRef, viewerReady, viewerRef } = useViewerRenderer({
    activeSelectionRef,
    clockRef: transport.clockRef,
    lightshowModeRef,
    replayRef,
    settings,
    settingsRef,
    performance: DEFAULT_RENDER_PERFORMANCE,
    skipInitialMenuEnvironment: true,
    setError,
  });
  const { reportEnvironmentError } = useViewerSettingsSync({
    viewerRef,
    activeSelectionRef,
    replayRef,
    lightshowModeRef,
    authoritativeLightshowMode: null,
    skipInitialMenuEnvironment: true,
    setError,
    setLightshowMode,
    persistedSettings: settings,
    settings,
    settingsRef,
    persistSettings: true,
  });
  const players = useMemo(
    () =>
      session.players.map(
        (player, index): ReplayPlayerView => ({
          replay: mirrorLeftHandedReplay(player.replay),
          name: player.name,
          colors: playerColors(index),
        }),
      ),
    [session],
  );
  const resolvedNames = useBrPlayerNames(session.players);
  // A player listed twice gets a key per entry, so each entry has its own overrides
  const playerKeys = useMemo(() => brPlayerKeys(session.players), [session]);
  const overrides = playerKeys.map((key) => brSettings.players[key] ?? DEFAULT_BR_PLAYER_OVERRIDES);
  // A display name override replaces the resolved name in the panel and the 3D label
  const names = resolvedNames.map((name, index) => {
    const override = overrides[index]?.name.trim() ?? '';
    return override === '' ? name : override;
  });
  const namesKey = names.join('\n');
  const namesRef = useRef(names);
  namesRef.current = names;
  const styles = players.map((player, index) =>
    brPlayerStyle(overrides[index] ?? DEFAULT_BR_PLAYER_OVERRIDES, player.colors),
  );
  // Names have their own path (setReplayPlayerNames), so typing one does not re-apply sabers and clear trails
  const stylesKey = JSON.stringify(styles);
  const stylesRef = useRef(styles);
  stylesRef.current = styles;
  const namedPlayers = useMemo(
    () =>
      players.map((player, index) => ({
        ...player,
        name: names[index] ?? player.name,
        colors: styles[index]?.colors ?? player.colors,
      })),
    [players, namesKey, stylesKey],
  );
  const settingsPlayers = useMemo(
    () =>
      players.map((player, index) => ({
        key: playerKeys[index] ?? '',
        name: resolvedNames[index] ?? player.name,
        colors: player.colors,
      })),
    [players, playerKeys, resolvedNames.join('\n')],
  );

  // Parses the map and loads the song clock, once per session
  useEffect(() => {
    const primary = players[0];
    if (primary === undefined) return;
    let cancelled = false;
    const parser = new BeatmapParser();

    async function load() {
      if (primary === undefined) return;
      const parsed = await Result.tryPromise(() => parseMapPackage(session.map.files, parser, primary.replay));
      if (cancelled) return;
      if (parsed.isErr()) {
        setError(`${t('errors.failedMap')}: ${parsed.error.message}`);
        return;
      }
      const { audioData, rows, songBpm: bpm } = parsed.value;
      const row = rows.find((candidate) => candidate.replayMatch === true);
      if (row?.difficulty === undefined || row.infoDifficulty === undefined || row.environmentId === undefined) {
        setError(t('errors.replayDifficultyMismatch'));
        return;
      }
      setMapMeta(parsed.value.mapMeta);
      setSongBpm(bpm);
      // parseMapPackage converts only the replay it is given; old ScoreSaber replays need the parsed difficulty
      for (const player of players) convertLegacyScoreSaberReplay(player.replay, row.difficulty, bpm);
      const { data } = buildMultiReplayMapRenderData(
        row.difficulty,
        {
          ...replayMapRenderOptions(row.infoDifficulty, row.legacyNoodleV2Semantics, bpm, primary.replay),
          leftHanded: false,
        },
        players.map((player) => player.replay.notes),
      );
      setTimelines(players.map((player) => buildReplayScoreTimeline(player.replay)));

      const currentSettings = settingsRef.current;
      const replayEnd = Math.max(...players.map((player) => player.replay.poses.at(-1)?.time ?? 0));
      const clock = transport.load({
        audioEnabled: currentSettings.masterVolume > 0,
        audioData,
        fallbackDuration: Math.max(songBpmTimeToSeconds(data.endBeat, bpm) + 1, replayEnd),
        hitsoundEvents: buildHitsoundEvents([...data.notes, ...data.chainLinks], bpm),
        onAudioDecodeError() {
          setError(t('errors.audioDecode'));
        },
        shouldCommit: () => !cancelled,
        songBpm: bpm,
        volume:
          currentSettings.masterMuted || currentSettings.songMuted
            ? 0
            : currentSettings.masterVolume * currentSettings.songVolume,
      });
      setLoaded({
        selection: {
          data,
          mapEnvironmentId: row.environmentId,
          replayEnvironmentId: row.replayEnvironmentId,
          usesChromaOrNoodle: row.infoDifficulty.usesChromaOrNoodle,
          mapColorScheme: row.colorScheme,
        },
        clock,
      });
    }

    void load();
    return () => {
      cancelled = true;
      parser.dispose();
    };
  }, [players]);

  // Shows the map and every player, and again whenever the renderer is rebuilt (graphics quality setting)
  useEffect(() => {
    const view = viewerRef.current?.view;
    if (!viewerReady || view === undefined || loaded === null) return;
    let cancelled = false;

    async function show() {
      if (view === undefined || loaded === null) return;
      const { selection } = loaded;
      const currentSettings = settingsRef.current;
      const focused = focusedIndexRef.current;
      const focusedReplay = players[focused]?.replay ?? null;
      replayRef.current = focusedReplay;
      const environmentId = resolveEnvironmentId(
        environmentForSettings(
          currentSettings,
          selection.mapEnvironmentId,
          selection.replayEnvironmentId,
          selection.usesChromaOrNoodle,
        ),
      );
      const environmentResult = await view.setEnvironment(environmentId, selection.data.chromaEnvironment);
      if (cancelled) return;
      if (environmentResult.isErr()) {
        reportEnvironmentError(environmentResult.error);
        return;
      }
      view.setLightshowMode(lightshowModeRef.current);
      activeSelectionRef.current = { ...selection, environmentId };
      view.setBeatSource(() => 0);
      // Sabers always get each player's own colours; notes and environment follow the colour settings
      view.setMap(selection.data, colorOverride(currentSettings, selection.mapColorScheme, focusedReplay?.metadata));
      view.setReplayPlayers(
        players.map((player, index) => ({ ...player, name: namesRef.current[index] ?? player.name })),
        focused,
        hitScoreVisualizerForSettings(currentSettings, focusedReplay),
      );
      view.setReplayPlayerStyles(stylesRef.current);
      view.setReplayCameraSettings(currentSettings);

      const clock = await loaded.clock;
      if (cancelled || clock === null) return;
      view.setSongDuration(clock.duration);
      view.setBeatSource(() => transport.clockRef.current?.currentBeat() ?? 0);
    }

    void show();
    return () => {
      cancelled = true;
    };
  }, [viewerReady, loaded]);

  useEffect(() => {
    viewerRef.current?.view.setReplayPlayerNames(namesRef.current);
  }, [namesKey, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setReplayPlayerStyles(stylesRef.current);
  }, [stylesKey, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setMainOrthographic(mainOrtho);
  }, [mainOrtho, viewerReady]);

  // The HUD lives on the main view, so this survives focus swaps; viewerReady re-applies it after a rebuild
  useEffect(() => {
    viewerRef.current?.view.setHitScoresOnly(brSettings.hitScoresOnly);
  }, [brSettings.hitScoresOnly, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setMainOrthographicZoom(brSettings.orthoZoom);
  }, [brSettings.orthoZoom, viewerReady]);

  useEffect(() => {
    viewerRef.current?.view.setMainOrthographicView(brSettings.orthoView);
  }, [brSettings.orthoView, viewerReady]);

  useEffect(() => {
    saveBrSettings(brSettings);
  }, [brSettings]);

  function focusPlayer(index: number) {
    const replay = players[index]?.replay ?? null;
    focusedIndexRef.current = index;
    replayRef.current = replay;
    setFocusedIndex(index);
    const view = viewerRef.current?.view;
    if (view === undefined) return;
    const currentSettings = settingsRef.current;
    view.setFocusedPlayer(index, hitScoreVisualizerForSettings(currentSettings, replay));
    // "Prefer replay colours" follows the followed player
    const active = activeSelectionRef.current;
    if (active !== null) view.refreshMapColors(colorOverride(currentSettings, active.mapColorScheme, replay?.metadata));
  }

  // As in the single-replay viewer, picking lights also updates the saved static-lights setting
  function changeLightshowMode(mode: LightshowMode) {
    lightshowModeRef.current = mode;
    setLightshowMode(mode);
    viewerRef.current?.view.setLightshowMode(mode);
    if (mode !== 'none') setSettings((current) => ({ ...current, staticLights: mode === 'static' }));
  }

  return {
    canvasRef,
    changeLightshowMode,
    environmentLoading,
    error,
    focusPlayer,
    focusedIndex,
    lightshowMode,
    lightshowForced: isForcedLightshowMode(lightshowMode),
    mainOrtho,
    setMainOrtho,
    brSettings,
    setBrSettings,
    settingsPlayers,
    mapMeta,
    orthoOverlayRef,
    players: namedPlayers,
    ready: timelines !== null,
    setError,
    setSettings,
    settings,
    settingsRef,
    songBpm,
    timelines,
    transport,
  };
}
