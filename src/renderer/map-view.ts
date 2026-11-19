import { Result } from 'better-result';
import { BufferAttribute, BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';

import { HeckBaseProviderRuntime } from '../core/animation/base-provider';
import { songBpmTimeToSeconds } from '../core/beatmap/bpm';
import type { InfoColorScheme } from '../core/beatmap/info';
import type { ChromaEnvironmentData } from '../core/chroma-environment';
import { DEFAULT_COLORS, resolveColorScheme, type ColorScheme, type Rgb } from '../core/colors';
import { isForcedLightshowMode, shouldShowMapObjects, type LightshowMode } from '../core/lighting/basic-light';
import { sampleNoodlePlayerTrack } from '../core/noodle-runtime';
import { applyReplayHeightEvents, applyReplayNoteEvents, type MapRenderData } from '../core/placement/map-render-data';
import type { PlayerColors } from '../core/player-colors';
import { DEFAULT_REPLAY_PLAYER_STYLE, playerSaberSettings, type ReplayPlayerStyle } from '../core/replay-player-style';
import type { HitScoreVisualizerConfig } from '../core/replay/hit-score-visualizer';
import type { Replay, ReplayHeightEvent, ReplayNoteEvent } from '../core/replay/types';
import {
  DEFAULT_REPLAY_CAMERA_SETTINGS,
  type ReplayCameraSettings,
  type ReplaySaberSettings,
} from '../core/viewer-settings';
import { BloomfogPipeline } from './bloomfog/pipeline';
import { fixedCameraPosition, GAMEPLAY_CAMERA_FAR, MAIN_MENU_CAMERA_DISTANCE } from './camera';
import {
  EnvironmentLoadAborted,
  environmentLoadFailure,
  type EnvironmentLoadFailure,
} from './environment/environment-error';
import { loadEnvironment } from './environment/environment-loader';
import type { LoadedEnvironment } from './environment/environment-runtime';
import { EnvironmentLightRuntime } from './map/environment-light-runtime';
import { MapObjectRenderer } from './map/map-object-renderer';
import { NoodlePlayerTransform } from './map/noodle-player-transform';
import { createMirrorMaterial, createSkyboxMaterial } from './materials/scene-materials';
import { collectMirrorConsumers, hasVisibleMirrorConsumer } from './mirror/mirror-consumers';
import {
  AFTER_SCREEN_DISPLACEMENT_LAYER,
  MAIN_ONLY_LAYER,
  PlanarMirror,
  SCREEN_DISPLACEMENT_LAYER,
} from './mirror/planar-mirror';
import { PostBloomPipeline } from './post-bloom/pipeline';
import { DEFAULT_QUALITY } from './quality';
import { DEFAULT_RENDER_PERFORMANCE, type RenderPerformanceOptions } from './render-performance';
import type { RenderView } from './renderer-lifecycle';
import { hudLayoutFor } from './replay/hud/hud-layouts';
import { ReplayOrthographicOverlay } from './replay/orthographic-overlay';
import type { ReplayCameraMode } from './replay/replay-camera';
import { ReplayView } from './replay/replay-view';

/** One player of a multi-player scene (see MapView.setReplayPlayers). */
export interface ReplayPlayerView {
  replay: Replay;
  name: string;
  colors: PlayerColors;
}

function fullscreenTriangle() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return geometry;
}

export class MapView implements RenderView {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(
    DEFAULT_REPLAY_CAMERA_SETTINGS.replayCameraFov,
    1,
    0.1,
    GAMEPLAY_CAMERA_FAR,
  );
  private readonly playerCameraRoot = new Group();
  private readonly playerCameraHead = new Group();
  private readonly noodlePlayerTransform = new NoodlePlayerTransform();
  private readonly mapRoot = new Group();
  private readonly baseProviders = new HeckBaseProviderRuntime(
    (name, beat) => this.baseProvider(name, beat),
    (beat) => songBpmTimeToSeconds(beat, this.data?.songBpm ?? 120),
  );

  private readonly pipeline: BloomfogPipeline;
  private readonly postBloom: PostBloomPipeline;
  private readonly mirror: PlanarMirror;
  private readonly skybox: Mesh;
  private readonly replayView: ReplayView;
  // Multi-player scenes (setReplayPlayers): replayView shows the focused player, these render-only views the others.
  // renderOnlyPlayers[i] is the index in `players` that renderOnlyViews[i] shows.
  private readonly renderOnlyViews: ReplayView[] = [];
  private renderOnlyPlayers: number[] = [];
  private players: readonly ReplayPlayerView[] | null = null;
  // Per-player look by index in `players` (setReplayPlayerStyles); showPlayer applies it to whichever view shows them
  private playerStyles: readonly ReplayPlayerStyle[] = [];
  private focusedPlayer = 0;
  private replayCameraSettings: ReplayCameraSettings | null = null;
  private replaySaberSettings: ReplaySaberSettings | null = null;
  private readonly replayOrthographicOverlay = new ReplayOrthographicOverlay();
  // Battle Royale's ortho main camera (setMainOrthographic): the inset's camera, drawn over the whole canvas
  private mainOrthographic: ReplayOrthographicOverlay | null = null;
  private mainOrthographicZoom = 1;
  private mainOrthographicView: ReplayCameraSettings['orthoCameraView'] = 'back';
  private readonly mapObjects: MapObjectRenderer;
  private readonly environmentLights = new EnvironmentLightRuntime();
  private environment: LoadedEnvironment | null = null;
  private environmentMirrorConsumers: Mesh[] = [];
  private playerPlatformNodes: Array<{ node: Group; visible: boolean }> = [];
  private environmentRequest: {
    id: string;
    chromaEnvironment?: ChromaEnvironmentData;
    controller: AbortController;
    result: Promise<Result<void, EnvironmentLoadFailure>>;
  } | null = null;

  private lightshowMode: LightshowMode = 'full';
  private gameplayObjectsVisible = true;
  private colors: ColorScheme = DEFAULT_COLORS;
  private songDuration = 0;
  private menuLightshowSeed: number | null = null;
  private orthoCameraEnabled = DEFAULT_REPLAY_CAMERA_SETTINGS.orthoCameraEnabled;
  private screenDisplacementEffects = true;
  private playerPlatformVisible = true;

  private data: MapRenderData | null = null;
  private beatSource: () => number = () => 0;

  constructor(
    quality = DEFAULT_QUALITY,
    private readonly onEnvironmentLoadSettled: () => void = () => undefined,
    performance: RenderPerformanceOptions = DEFAULT_RENDER_PERFORMANCE,
    private readonly orthoOverlayElement: () => HTMLElement | null = () => null,
  ) {
    this.pipeline = new BloomfogPipeline(performance.bloomFogSize);
    this.postBloom = new PostBloomPipeline(performance.postBloomWidth, performance.msaaSamples);
    this.mirror = new PlanarMirror(quality, 6, 400, {
      resolution: performance.mirrorResolution,
      msaaSamples: performance.mirrorMsaaSamples,
    });
    this.camera.position.set(...fixedCameraPosition(DEFAULT_REPLAY_CAMERA_SETTINGS.previewCameraDistance));
    this.scene.matrixAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    this.camera.layers.enable(MAIN_ONLY_LAYER);
    this.camera.layers.enable(SCREEN_DISPLACEMENT_LAYER);
    this.camera.layers.enable(AFTER_SCREEN_DISPLACEMENT_LAYER);
    this.playerCameraHead.add(this.camera);
    this.playerCameraRoot.add(this.playerCameraHead);
    this.scene.add(this.playerCameraRoot);

    const fog = this.pipeline.fogUniforms;
    this.mapObjects = new MapObjectRenderer(this.mapRoot, fog, this.postBloom.screenDisplacementTexture, this.camera);

    this.skybox = new Mesh(fullscreenTriangle(), createSkyboxMaterial(fog));
    this.skybox.frustumCulled = false;
    this.skybox.renderOrder = -1000;
    this.scene.add(this.skybox);

    this.mirror.mesh.material = createMirrorMaterial(fog, this.mirror.reflectionTexture);
    this.mirror.mesh.position.set(0, 0, -150);
    this.mirror.mesh.visible = false;
    this.scene.add(this.mirror.mesh);

    this.scene.add(this.mapRoot);
    const directionalLights = this.environmentLights.directionalLights;
    this.replayView = new ReplayView(
      this.camera,
      fog,
      {
        directions: directionalLights.directions,
        colors: directionalLights.colors,
        positions: directionalLights.positions,
        radii: directionalLights.radii,
      },
      () => {
        this.mirror.updateMaterials(this.scene);
      },
    );
    this.replayView.hudRoot.traverse((object) => {
      object.layers.set(MAIN_ONLY_LAYER);
    });
    this.scene.add(this.replayView.hudRoot);
    this.scene.add(this.replayView.root);
    this.mirror.updateMaterials(this.scene);
    void this.replayView.loadHeadset();
  }

  setEnvironment(id: string, chromaEnvironment?: ChromaEnvironmentData): Promise<Result<void, EnvironmentLoadFailure>> {
    if (this.environment?.data.id === id && this.environment.chromaEnvironment === chromaEnvironment) {
      this.environmentRequest?.controller.abort();
      this.environmentRequest = null;
      return Promise.resolve(Result.ok(undefined));
    }
    if (this.environmentRequest?.id === id && this.environmentRequest.chromaEnvironment === chromaEnvironment) {
      return this.environmentRequest.result;
    }
    this.environmentRequest?.controller.abort();
    const controller = new AbortController();
    const result = this.loadAndApplyEnvironment(id, controller, chromaEnvironment);
    this.environmentRequest = { id, chromaEnvironment, controller, result };
    return result;
  }

  private async loadAndApplyEnvironment(
    id: string,
    controller: AbortController,
    chromaEnvironment?: ChromaEnvironmentData,
  ): Promise<Result<void, EnvironmentLoadFailure>> {
    const loadResult = await Result.tryPromise({
      try: () =>
        loadEnvironment(
          id,
          {
            fog: this.pipeline.fogUniforms,
            reflectionTexture: this.mirror.reflectionTexture,
            directionalLights: {
              directions: { value: this.environmentLights.directionalLights.directions },
              colors: { value: this.environmentLights.directionalLights.colors },
              positions: { value: this.environmentLights.directionalLights.positions },
              radii: { value: this.environmentLights.directionalLights.radii },
            },
            songTime: this.environmentLights.songTime,
          },
          controller.signal,
          chromaEnvironment,
        ),
      catch: (cause) => environmentLoadFailure(id, cause),
    });
    if (loadResult.isErr()) {
      if (this.environmentRequest?.controller === controller) {
        this.environmentRequest = null;
        this.onEnvironmentLoadSettled();
      }
      return Result.err(loadResult.error);
    }

    const environment = loadResult.value;
    if (controller.signal.aborted || this.environmentRequest?.controller !== controller) {
      environment.dispose();
      return Result.err(
        new EnvironmentLoadAborted({
          environmentId: id,
          message: `environment ${id} load was cancelled`,
        }),
      );
    }
    if (this.environment !== null) {
      this.scene.remove(this.environment.root);
      this.environment.dispose();
    }
    this.environment = environment;
    this.environmentRequest = null;
    this.playerPlatformNodes = [];
    environment.root.traverse((node) => {
      if (node instanceof Group && /^PlayersPlace(?:\(Clone\))*$/.test(node.name)) {
        this.playerPlatformNodes.push({ node, visible: node.visible });
      }
    });
    this.applyPlayerPlatformVisibility();
    this.environmentMirrorConsumers = collectMirrorConsumers(environment.root);
    this.scene.add(environment.root);
    this.environmentLights.setEnvironment(environment);
    this.replayView.setHudLayout(hudLayoutFor(id));
    this.mirror.updateMaterials(this.scene);
    this.pipeline.setFogParams(environment.data.fogParams);
    const hasCustomEnvironment =
      chromaEnvironment !== undefined &&
      (Object.keys(chromaEnvironment.materials).length > 0 ||
        chromaEnvironment.enhancements.length > 0 ||
        chromaEnvironment.animations.length > 0 ||
        chromaEnvironment.componentAnimations.length > 0 ||
        chromaEnvironment.fogTrackEvents.length > 0);
    this.pipeline.setBackgroundGradient(hasCustomEnvironment ? null : environment.backgroundGradient);
    this.onEnvironmentLoadSettled();
    return Result.ok(undefined);
  }

  setBeatSource(source: () => number) {
    this.beatSource = source;
  }

  startMenuLightshow(seed: number) {
    const startedAt = performance.now();
    this.menuLightshowSeed = seed;
    this.beatSource = () => (performance.now() - startedAt) / 500;
    this.replayView.setPreviewCameraDistanceOverride(MAIN_MENU_CAMERA_DISTANCE);
    this.environmentLights.setMenuLightshow(seed);
  }

  setLightshowMode(mode: LightshowMode) {
    this.lightshowMode = mode;
    this.environmentLights.setLightshowMode(mode);
    this.updateMapRootVisibility();
    this.replayView.setLightshowMode(mode);
    for (const view of this.renderOnlyViews) view.setLightshowMode(mode);
    this.mapObjects.invalidate();
  }

  clear() {
    this.clearMap();
    this.setSongDuration(null);
    this.setReplay(null);
    if (this.menuLightshowSeed !== null) this.startMenuLightshow(this.menuLightshowSeed);
  }

  setReplay(replay: Replay | null, hitScoreVisualizer?: HitScoreVisualizerConfig | null) {
    this.clearReplayPlayers();
    this.replayView.setReplay(replay, hitScoreVisualizer);
    this.baseProviders.reset();
    this.mapObjects.invalidate();
  }

  /**
   * Shows several players on the map at once. The focused player owns the camera, the gameplay HUD and the
   * Noodle/Chroma player tracks; the others only draw sabers, trails, headset and name label. Every replay must
   * already be right-handed (see mirrorLeftHandedReplay). `setReplay` returns the view to a single replay.
   */
  setReplayPlayers(
    players: readonly ReplayPlayerView[],
    focusedIndex: number,
    hitScoreVisualizer?: HitScoreVisualizerConfig | null,
  ) {
    this.clearReplayPlayers();
    const focused = players[focusedIndex];
    if (focused === undefined) {
      this.replayView.setReplay(null);
    } else {
      this.players = players;
      this.focusedPlayer = focusedIndex;
      for (const [index, player] of players.entries()) {
        if (index === focusedIndex) continue;
        const view = this.createRenderOnlyView();
        this.renderOnlyViews.push(view);
        this.renderOnlyPlayers.push(index);
        view.setReplay(player.replay);
        this.showPlayer(view, index, true);
      }
      this.replayView.setReplay(focused.replay, hitScoreVisualizer);
      this.showPlayer(this.replayView, focusedIndex, true);
      this.mirror.updateMaterials(this.scene);
    }
    this.baseProviders.reset();
    this.mapObjects.invalidate();
  }

  /** Moves the camera, HUD and player tracks to another player of setReplayPlayers. */
  setFocusedPlayer(index: number, hitScoreVisualizer?: HitScoreVisualizerConfig | null) {
    const slot = this.renderOnlyPlayers.indexOf(index);
    const view = this.renderOnlyViews[slot];
    const player = this.players?.[index];
    const previous = this.players?.[this.focusedPlayer];
    if (view === undefined || player === undefined || previous === undefined) return;
    // Only the two swapped views reset; every other player keeps its view and trails
    this.renderOnlyPlayers[slot] = this.focusedPlayer;
    view.setReplay(previous.replay);
    this.showPlayer(view, this.focusedPlayer, true);
    this.focusedPlayer = index;
    this.replayView.setReplay(player.replay, hitScoreVisualizer);
    this.showPlayer(this.replayView, index, true);
    this.baseProviders.reset();
    this.mapObjects.invalidate();
  }

  /**
   * Overrides colours, saber look and visibility per player of setReplayPlayers, by index. The style follows the
   * player across setFocusedPlayer swaps; a player without one uses the global settings.
   */
  setReplayPlayerStyles(styles: readonly ReplayPlayerStyle[]) {
    if (this.players === null) return;
    this.playerStyles = styles;
    this.showAllPlayers(true);
  }

  /** Renames the players of setReplayPlayers in place, e.g. once their profiles have loaded. */
  setReplayPlayerNames(names: readonly string[]) {
    if (this.players === null) return;
    this.players = this.players.map((player, index) => ({ ...player, name: names[index] ?? player.name }));
    this.showAllPlayers(false);
  }

  private showAllPlayers(applySabers: boolean) {
    this.showPlayer(this.replayView, this.focusedPlayer, applySabers);
    for (const [slot, view] of this.renderOnlyViews.entries()) {
      const index = this.renderOnlyPlayers[slot];
      if (index !== undefined) this.showPlayer(view, index, applySabers);
    }
  }

  private createRenderOnlyView() {
    const directionalLights = this.environmentLights.directionalLights;
    const view = new ReplayView(
      null,
      this.pipeline.fogUniforms,
      {
        directions: directionalLights.directions,
        colors: directionalLights.colors,
        positions: directionalLights.positions,
        radii: directionalLights.radii,
      },
      () => {
        this.mirror.updateMaterials(this.scene);
      },
    );
    view.setLightshowMode(this.lightshowMode);
    if (this.replayCameraSettings !== null) view.setCameraSettings(this.replayCameraSettings);
    if (this.replaySaberSettings !== null) view.setSaberSettings(this.replaySaberSettings);
    view.setNoodleTrailLocalSpace(this.data?.noodle.localSpaceSaberTrail ?? false);
    this.scene.add(view.root);
    void view.loadHeadset();
    return view;
  }

  private playerStyle(index: number) {
    return this.playerStyles[index] ?? DEFAULT_REPLAY_PLAYER_STYLE;
  }

  private playerColors(index: number) {
    return this.playerStyle(index).colors ?? this.players?.[index]?.colors;
  }

  private playerColorScheme(index: number): ColorScheme {
    const colors = this.playerColors(index);
    return colors === undefined ? this.colors : { ...this.colors, leftNote: colors.left, rightNote: colors.right };
  }

  private showPlayer(view: ReplayView, index: number, applySabers: boolean) {
    const player = this.players?.[index];
    const colors = this.playerColors(index);
    if (player === undefined || colors === undefined) return;
    const style = this.playerStyle(index);
    view.setColors(this.playerColorScheme(index));
    view.setHeadsetTint(colors.left);
    view.setNameLabel({ name: player.name, color: colors.left });
    view.setPlayerVisibility(style.showHeadset, style.showLabel);
    view.setSaberOpacity(style.saberOpacity);
    // Saber settings rebuild the sabers and clear trails, so renames and colour changes skip them
    if (applySabers && this.replaySaberSettings !== null) {
      view.setSaberSettings(playerSaberSettings(this.replaySaberSettings, style));
    }
  }

  private clearReplayPlayers() {
    for (const view of this.renderOnlyViews) {
      this.scene.remove(view.root);
      view.dispose();
    }
    this.renderOnlyViews.length = 0;
    this.renderOnlyPlayers = [];
    if (this.players === null) return;
    this.players = null;
    this.playerStyles = [];
    this.focusedPlayer = 0;
    this.replayView.setColors(this.colors);
    this.replayView.setHeadsetTint(null);
    this.replayView.setNameLabel(null);
    this.replayView.setPlayerVisibility(true, true);
    this.replayView.setSaberOpacity(1);
    if (this.replaySaberSettings !== null) this.replayView.setSaberSettings(this.replaySaberSettings);
    this.mirror.updateMaterials(this.scene);
  }

  setHitScoreVisualizer(hitScoreVisualizer: HitScoreVisualizerConfig | null) {
    this.replayView.setHitScoreVisualizer(hitScoreVisualizer);
  }

  setGameUIEnabled(enabled: boolean) {
    this.replayView.setGameUIEnabled(enabled);
  }

  setLightBrightness(brightness: number) {
    this.environmentLights.setLightBrightness(brightness);
  }

  setHitScoresOnly(hitScoresOnly: boolean) {
    this.replayView.setHitScoresOnly(hitScoresOnly);
  }

  setPlayerPlatformVisible(visible: boolean) {
    this.playerPlatformVisible = visible;
    this.applyPlayerPlatformVisibility();
  }

  private applyPlayerPlatformVisibility() {
    for (const platform of this.playerPlatformNodes) {
      platform.node.visible = this.playerPlatformVisible ? platform.visible : false;
    }
    if (this.playerPlatformVisible) this.environment?.enforceChromaRemoval();
  }

  setGameplayNotesVisible(visible: boolean) {
    this.gameplayObjectsVisible = visible;
    this.updateMapRootVisibility();
    this.mapObjects.setGameplayNotesVisible(visible);
  }

  private updateMapRootVisibility() {
    // A showcase hides gameplay objects inside MapObjectRenderer, but its fake
    // walls are part of the lightshow and must keep the map root rendered.
    this.mapRoot.visible = shouldShowMapObjects(this.lightshowMode, this.gameplayObjectsVisible);
  }

  setSongDuration(duration: number | null) {
    this.songDuration = duration ?? 0;
    this.replayView.setSongDuration(duration);
  }

  appendReplayNoteEvents(events: ReplayNoteEvent[]) {
    if (this.data !== null && events.length > 0) {
      applyReplayNoteEvents(this.data, events);
      this.mapObjects.invalidate();
    }
    this.replayView.refreshTimeline();
  }

  appendReplayHeightEvents(events: ReplayHeightEvent[]) {
    if (this.data === null || events.length === 0) return;
    applyReplayHeightEvents(this.data, events);
    this.mapObjects.invalidate();
  }

  setReplayCameraMode(mode: ReplayCameraMode) {
    this.replayView.setCameraMode(mode);
  }

  setReplayCameraSettings(settings: ReplayCameraSettings) {
    this.orthoCameraEnabled = settings.orthoCameraEnabled;
    this.replayOrthographicOverlay.setView(settings.orthoCameraView);
    this.replayView.setCameraSettings(settings);
    this.replayCameraSettings = settings;
    for (const view of this.renderOnlyViews) view.setCameraSettings(settings);
  }

  /**
   * Renders the whole view through an orthographic camera like the ortho inset's, at its own angle
   * (setMainOrthographicView), instead of the replay camera; the inset is not drawn meanwhile. Off restores the normal
   * camera.
   */
  setMainOrthographic(enabled: boolean) {
    if (enabled === (this.mainOrthographic !== null)) return;
    if (enabled) {
      this.mainOrthographic = new ReplayOrthographicOverlay(true);
      this.mainOrthographic.setView(this.mainOrthographicView);
      this.mainOrthographic.setZoom(this.mainOrthographicZoom);
    } else {
      this.mainOrthographic?.dispose();
      this.mainOrthographic = null;
    }
  }

  /** Angle of the ortho main camera (setMainOrthographic), apart from the inset's orthoCameraView. */
  setMainOrthographicView(view: ReplayCameraSettings['orthoCameraView']) {
    this.mainOrthographicView = view;
    this.mainOrthographic?.setView(view);
  }

  /** Zooms the ortho main camera (setMainOrthographic) around its view center; 1 is the inset's framing. */
  setMainOrthographicZoom(zoom: number) {
    this.mainOrthographicZoom = zoom;
    this.mainOrthographic?.setZoom(zoom);
  }

  setReplaySaberSettings(settings: ReplaySaberSettings) {
    this.replaySaberSettings = settings;
    if (this.players !== null) {
      // Each player merges their own saber style over these
      this.showAllPlayers(true);
      return;
    }
    this.replayView.setSaberSettings(settings);
  }

  setScreenDisplacementEffects(enabled: boolean) {
    this.screenDisplacementEffects = enabled;
    this.postBloom.setScreenDisplacementEnabled(enabled);
    this.mapObjects.setScreenDisplacementEffects(enabled);
  }

  setRenderPerformance(performance: RenderPerformanceOptions) {
    this.pipeline.setCaptureSize(performance.bloomFogSize);
    this.postBloom.setPerformance(performance.postBloomWidth, performance.msaaSamples);
    const mirrorChanged = this.mirror.setPerformance(performance.mirrorResolution, performance.mirrorMsaaSamples);
    if (mirrorChanged) this.mirror.updateMaterials(this.scene);
  }

  setPreviewNotesLookAtPlayer(enabled: boolean) {
    this.mapObjects.setPreviewNotesLookAtPlayer(enabled);
  }

  setPreviewHitNotes(enabled: boolean) {
    this.mapObjects.setPreviewHitNotes(enabled);
  }

  setPreviewHitLine(enabled: boolean) {
    this.mapObjects.setPreviewHitLine(enabled);
  }

  setMap(data: MapRenderData, override?: InfoColorScheme) {
    this.replayView.setPreviewCameraDistanceOverride(null);
    this.clearMap();
    this.data = data;
    this.replayView.setMapHasNotes(data.notes.length > 0);
    this.replayView.setNoodleTrailLocalSpace(data.noodle.localSpaceSaberTrail);
    for (const view of this.renderOnlyViews) view.setNoodleTrailLocalSpace(data.noodle.localSpaceSaberTrail);

    const colors = this.resolveMapColors(override);
    this.colors = colors;
    this.baseProviders.reset();
    this.environmentLights.setMap(data, colors);
    if (this.players === null) this.replayView.setColors(colors);
    else this.showAllPlayers(false);
    this.mapObjects.setMap(data, colors);
    this.mirror.updateMaterials(this.scene);
  }

  refreshMapColors(override?: InfoColorScheme) {
    if (this.data === null) return;
    const colors = this.resolveMapColors(override);
    this.colors = colors;
    this.baseProviders.reset();
    this.environmentLights.setColors(colors);
    if (this.players === null) this.replayView.setColors(colors);
    else this.showAllPlayers(false);
    this.mapObjects.setColors(colors);
  }

  private resolveMapColors(override?: InfoColorScheme) {
    return this.environment === null ? DEFAULT_COLORS : resolveColorScheme(this.environment.data.colorScheme, override);
  }

  private clearMap() {
    this.mapObjects.clear();
    this.data = null;
    this.replayView.setMapHasNotes(false);
    this.replayView.setNoodleTrailLocalSpace(false);
    for (const view of this.renderOnlyViews) view.setNoodleTrailLocalSpace(false);
    this.environmentLights.clearMap();
    this.mirror.updateMaterials(this.scene);
  }

  private baseProvider(name: string, beat: number): readonly number[] | undefined {
    const data = this.data;
    const color = (value: Rgb): readonly [number, number, number, number] => [value[0], value[1], value[2], 1];
    const colors = this.colors;
    // Map render data already swaps each note's colour index in left-handed
    // mode. Swapping the palette here as well cancelled that transformation.
    if (name === 'baseNote0Color') return color(colors.leftNote);
    if (name === 'baseNote1Color') return color(colors.rightNote);
    if (name === 'baseObstaclesColor') return color(colors.obstacle);
    if (name === 'baseSaberAColor') return color(colors.leftNote);
    if (name === 'baseSaberBColor') return color(colors.rightNote);
    if (name === 'baseEnvironmentColor0') return color(colors.environmentLeft);
    if (name === 'baseEnvironmentColor1') return color(colors.environmentRight);
    if (name === 'baseEnvironmentColorW') return color(colors.environmentWhite);
    if (name === 'baseEnvironmentColor0Boost') return color(colors.environmentLeftBoost);
    if (name === 'baseEnvironmentColor1Boost') return color(colors.environmentRightBoost);
    if (name === 'baseEnvironmentColorWBoost') return color(colors.environmentWhiteBoost);
    const seconds = songBpmTimeToSeconds(beat, data?.songBpm ?? 120);
    if (name === 'baseSongTime') return [seconds];
    if (name === 'baseSongLength') return [this.songDuration];
    if (name === 'basePlayerHeight') return [this.playerHeightAt(seconds)];
    if (data !== null) {
      const movement = data.movementStateAt?.(beat);
      if (name === 'baseNoteJumpMovementSpeed') return [movement?.noteJumpSpeed ?? data.noteJumpSpeed ?? 0];
      if (name === 'baseNoteJumpStartBeatOffset') return [data.noteStartBeatOffset ?? 0];
      if (name === 'baseJumpDistance') return [movement?.jumpDistance ?? 0];
    }
    return this.replayView.baseProvider(name, seconds);
  }

  private playerHeightAt(time: number) {
    const data = this.data;
    if (data === null) return 1.8;
    let low = 0;
    let high = data.replayHeights.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((data.replayHeights[middle]?.time ?? Number.POSITIVE_INFINITY) <= time) low = middle + 1;
      else high = middle;
    }
    return data.replayHeights[low - 1]?.height ?? data.initialPlayerHeight;
  }

  private update(now: number) {
    const data = this.data;
    if (this.environment !== null) {
      const fog = this.environmentLights.update(now, this.baseProviders);
      if (fog !== undefined) this.pipeline.setFogParams(fog);
      if (!this.playerPlatformVisible) this.applyPlayerPlatformVisibility();
    }
    if (data === null) return;
    if (!shouldShowMapObjects(this.lightshowMode, this.gameplayObjectsVisible)) return;
    const replayTime = songBpmTimeToSeconds(now, data.songBpm);
    this.playerCameraRoot.position.set(0, 0, 0);
    this.playerCameraRoot.quaternion.identity();
    this.playerCameraRoot.scale.set(1, 1, 1);
    this.playerCameraHead.position.set(0, 0, 0);
    this.playerCameraHead.quaternion.identity();
    this.playerCameraHead.scale.set(1, 1, 1);
    const rootTrack = sampleNoodlePlayerTrack(data.noodle, 'Root', now, this.baseProviders, data.leftHanded);
    const headTrack = sampleNoodlePlayerTrack(data.noodle, 'Head', now, this.baseProviders, data.leftHanded);
    if (!this.replayView.hasReplay || this.replayView.cameraMode === 'static') {
      this.noodlePlayerTransform.apply(this.playerCameraRoot, rootTrack, data.leftHanded);
      this.noodlePlayerTransform.apply(this.playerCameraHead, headTrack, data.leftHanded);
    }
    const noodle = this.replayView.hasReplay
      ? {
          root: rootTrack,
          head: headTrack,
          leftHand: sampleNoodlePlayerTrack(data.noodle, 'LeftHand', now, this.baseProviders, data.leftHanded),
          rightHand: sampleNoodlePlayerTrack(data.noodle, 'RightHand', now, this.baseProviders, data.leftHanded),
        }
      : undefined;
    this.replayView.update(replayTime, noodle, data.leftHanded);
    // Every player follows the same player tracks, sampled once above
    for (const view of this.renderOnlyViews) view.update(replayTime, noodle, data.leftHanded);
    this.mapObjects.update(now, this.replayView, this.baseProviders);
  }

  render(renderer: WebGLRenderer) {
    this.renderFrame(renderer);
  }

  renderViewport(
    renderer: WebGLRenderer,
    output: { x: number; y: number; width: number; height: number; renderWidth?: number; renderHeight?: number },
  ) {
    this.renderFrame(renderer, output);
  }

  private renderFrame(
    renderer: WebGLRenderer,
    output?: { x: number; y: number; width: number; height: number; renderWidth?: number; renderHeight?: number },
  ) {
    const now = this.environment === null && this.data === null ? 0 : this.beatSource();
    this.update(now);
    this.scene.updateMatrixWorld();
    if (this.environment?.applyConstraints() === true) this.scene.updateMatrixWorld();
    this.environment?.syncInstancedMeshes();
    if (this.environment !== null) this.environmentLights.updateWorldLights(now);
    const mainOrthographic = this.mainOrthographic;
    if (
      mainOrthographic !== null &&
      output === undefined &&
      this.replayView.hasReplay &&
      !isForcedLightshowMode(this.lightshowMode)
    ) {
      this.renderOrthographic(now, false, (scene) => {
        mainOrthographic.renderFullscreen(renderer, scene);
      });
      return;
    }
    if (hasVisibleMirrorConsumer(this.environmentMirrorConsumers, this.camera)) {
      this.mirror.render(renderer, this.scene, this.camera, (mirrorRenderer, mirrorCamera) => {
        this.pipeline.render(mirrorRenderer, mirrorCamera, this.environmentLights.lightSegments);
      });
    }
    this.pipeline.render(renderer, this.camera, this.environmentLights.lightSegments);
    this.postBloom.render(
      renderer,
      this.scene,
      this.camera,
      this.mapRoot.visible && this.mapObjects.wallsVisible,
      output,
    );
    if (this.orthoCameraEnabled && this.replayView.hasReplay && !isForcedLightshowMode(this.lightshowMode)) {
      const element = this.orthoOverlayElement();
      if (element !== null) {
        // From the side, players are told apart by their headsets, so the inset always draws them
        const sideView = (this.replayCameraSettings?.orthoCameraView ?? 'back') !== 'back';
        this.renderOrthographic(now, sideView, (scene) => {
          this.replayOrthographicOverlay.render(renderer, scene, element);
        });
      }
    }
  }

  // Shows the scene the way the orthographic camera draws it (no environment, sky, mirror, HUD or fog) during `draw`;
  // `forceHeadsets` draws every player's headset whatever the Show headset settings
  private renderOrthographic(beat: number, forceHeadsets: boolean, draw: (scene: Scene) => void) {
    const environmentRoot = this.environment?.root;
    const environmentVisible = environmentRoot?.visible ?? false;
    const skyboxVisible = this.skybox.visible;
    const mirrorVisible = this.mirror.mesh.visible;
    const hudVisible = this.replayView.hudRoot.visible;
    const fog = this.pipeline.fogUniforms;
    const fogAttenuation = fog._CustomFogAttenuation.value;
    const fogHeight = fog._CustomFogHeightFogHeight.value;
    const fogStartY = fog._CustomFogHeightFogStartY.value;

    try {
      if (environmentRoot !== undefined) environmentRoot.visible = false;
      this.skybox.visible = false;
      this.mirror.mesh.visible = false;
      this.replayView.hudRoot.visible = false;
      this.replayView.setOrthographicOverlayRendering(true, forceHeadsets);
      for (const view of this.renderOnlyViews) view.setOrthographicOverlayRendering(true, forceHeadsets);
      fog._CustomFogAttenuation.value = 0;
      fog._CustomFogHeightFogHeight.value = 1;
      fog._CustomFogHeightFogStartY.value = -1_000_000;
      if (this.screenDisplacementEffects) this.mapObjects.setScreenDisplacementEffects(false);
      const halfJumpDistance = this.data?.movementStateAt?.(beat).halfJumpDistance;
      this.replayOrthographicOverlay.setHalfJumpDistance(halfJumpDistance);
      this.mainOrthographic?.setHalfJumpDistance(halfJumpDistance);
      draw(this.scene);
    } finally {
      if (this.screenDisplacementEffects) this.mapObjects.setScreenDisplacementEffects(true);
      fog._CustomFogAttenuation.value = fogAttenuation;
      fog._CustomFogHeightFogHeight.value = fogHeight;
      fog._CustomFogHeightFogStartY.value = fogStartY;
      this.replayView.setOrthographicOverlayRendering(false);
      for (const view of this.renderOnlyViews) view.setOrthographicOverlayRendering(false);
      this.replayView.hudRoot.visible = hudVisible;
      this.mirror.mesh.visible = mirrorVisible;
      this.skybox.visible = skyboxVisible;
      if (environmentRoot !== undefined) environmentRoot.visible = environmentVisible;
    }
  }

  contextRestored() {
    this.pipeline.invalidate();
  }

  setSize(width: number, height: number) {
    this.replayView.setCameraAspect(width / Math.max(height, 1));
    this.postBloom.setSize(width, height);
  }

  dispose() {
    this.environmentRequest?.controller.abort();
    this.environmentRequest = null;
    if (this.environment !== null) {
      this.scene.remove(this.environment.root);
      this.environment.dispose();
    }
    this.mapObjects.dispose();
    this.clearReplayPlayers();
    this.replayView.dispose();
    this.replayOrthographicOverlay.dispose();
    this.mainOrthographic?.dispose();
    for (const object of [this.skybox, this.mirror.mesh]) {
      if (!Array.isArray(object.material)) object.material.dispose();
    }
    this.skybox.geometry.dispose();
    this.mirror.dispose();
    this.pipeline.dispose();
    this.postBloom.dispose();
  }
}
