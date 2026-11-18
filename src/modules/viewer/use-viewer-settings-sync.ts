import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

import { useTranslations } from 'use-intl';

import { isForcedLightshowMode, type LightshowMode } from '../../core/lighting/basic-light';
import { hitScoreVisualizerForSettings } from '../../core/replay/replay-display';
import type { Replay } from '../../core/replay/types';
import {
  colorOverride,
  environmentForSettings,
  saveViewerSettings,
  type ViewerSettings,
} from '../../core/viewer-settings';
import { resolveEnvironmentId } from '../../renderer/environment/environment-catalog';
import { EnvironmentLoadAborted, type EnvironmentLoadFailure } from '../../renderer/environment/environment-error';
import type { ViewerHandle } from './use-viewer-renderer';
import type { ActiveSelection } from './viewer-types';

interface ViewerSettingsSyncOptions {
  viewerRef: RefObject<ViewerHandle | null>;
  activeSelectionRef: RefObject<ActiveSelection | null>;
  /** The replay whose colours, environment and hit score profile the "prefer replay" settings use. */
  replayRef: RefObject<Replay | null>;
  lightshowModeRef: RefObject<LightshowMode>;
  authoritativeLightshowMode: LightshowMode | null;
  skipInitialMenuEnvironment: boolean;
  setError: (message: string) => void;
  setLightshowMode: Dispatch<SetStateAction<LightshowMode>>;
  persistedSettings: ViewerSettings;
  settings: ViewerSettings;
  settingsRef: RefObject<ViewerSettings>;
  persistSettings: boolean;
}

/**
 * Saves the viewer settings and applies every change to the renderer live: render scale, lights, camera, sabers,
 * hit score profile, colours and environment. Shared by the single-replay viewer and the Battle Royale viewer.
 */
export function useViewerSettingsSync({
  viewerRef,
  activeSelectionRef,
  replayRef,
  lightshowModeRef,
  authoritativeLightshowMode,
  skipInitialMenuEnvironment,
  setError,
  setLightshowMode,
  persistedSettings,
  settings,
  settingsRef,
  persistSettings,
}: ViewerSettingsSyncOptions) {
  const t = useTranslations('viewer');

  useEffect(() => {
    if (!persistSettings) return;
    saveViewerSettings(persistedSettings);
  }, [persistSettings, persistedSettings]);

  useEffect(() => {
    viewerRef.current?.lifecycle.setRenderScale(settings.renderScale);
  }, [settings.renderScale]);

  useEffect(() => {
    viewerRef.current?.view.setScreenDisplacementEffects(settings.screenDisplacementEffects);
  }, [settings.screenDisplacementEffects]);

  useEffect(() => {
    viewerRef.current?.view.setPreviewNotesLookAtPlayer(settings.previewNotesLookAtPlayer);
  }, [settings.previewNotesLookAtPlayer]);

  useEffect(() => {
    viewerRef.current?.view.setPreviewHitNotes(settings.previewHitNotes);
  }, [settings.previewHitNotes]);

  useEffect(() => {
    viewerRef.current?.view.setPreviewHitLine(settings.previewHitLine);
  }, [settings.previewHitLine]);

  useEffect(() => {
    const mode: LightshowMode = authoritativeLightshowMode ?? (settings.staticLights ? 'static' : 'full');
    if (isForcedLightshowMode(lightshowModeRef.current) && mode === 'full') return;
    lightshowModeRef.current = mode;
    setLightshowMode(mode);
    viewerRef.current?.view.setLightshowMode(mode);
  }, [authoritativeLightshowMode, settings.staticLights]);

  useEffect(() => {
    viewerRef.current?.view.setReplayCameraSettings(settings);
  }, [
    settings.showHeadset,
    settings.orthoCameraEnabled,
    settings.orthoCameraView,
    settings.replayCamera,
    settings.replayCameraSmoothing,
    settings.replayCameraSmoothingSpeed,
    settings.replayCameraFov,
    settings.previewCameraDistance,
    settings.fixedCameraDistance,
    settings.replayCameraXOffset,
    settings.replayCameraYOffset,
    settings.replayCameraDepthOffset,
    settings.replayCameraXRotation,
    settings.replayCameraYRotation,
    settings.replayCameraZRotation,
    settings.replayCameraForceUpright,
  ]);

  useEffect(() => {
    viewerRef.current?.view.setReplaySaberSettings(settings);
  }, [
    settings.showSabers,
    settings.saberModel,
    settings.saberScale,
    settings.saberWidth,
    settings.mosSaberBrightness,
    settings.saberBladeLength,
    settings.saberBladeThickness,
    settings.saberCoreThickness,
    settings.saberCoreInset,
    settings.showSaberTrails,
    settings.replayTrailStyle,
    settings.replayTrailLength,
    settings.replayTrailThinness,
    settings.replayTrailSamples,
    settings.replayTrailFade,
    settings.replayTrailOpacity,
    settings.replayTrailMotionThreshold,
    settings.replayTrailSmoothing,
    settings.saberGripLength,
    settings.saberGripThickness,
    settings.saberGuardSize,
    settings.saberGuardThickness,
    settings.saberCollarSize,
    settings.saberCollarThickness,
    settings.saberCollarSpacing,
    settings.saberRingCount,
    settings.saberRingSize,
    settings.saberRingThickness,
    settings.saberRingSpacing,
    settings.saberPommelLength,
    settings.saberPommelThickness,
    settings.saberXOffset,
    settings.saberYOffset,
    settings.saberZOffset,
    settings.saberXRotation,
    settings.saberYRotation,
    settings.saberZRotation,
  ]);

  useEffect(() => {
    viewerRef.current?.view.setHitScoreVisualizer(hitScoreVisualizerForSettings(settings, replayRef.current));
  }, [settings.overrideHsvProfile, settings.preferReplayHsvProfile, settings.hsvProfile]);

  useEffect(() => {
    const active = activeSelectionRef.current;
    const view = viewerRef.current?.view;
    if (active === null || view === undefined) return;
    view.refreshMapColors(colorOverride(settings, active.mapColorScheme, replayRef.current?.metadata));
  }, [
    settings.preferReplayColors,
    settings.preferReplayEnvironmentColors,
    settings.customEnvironmentColors,
    settings.customColors,
    settings.leftColor,
    settings.rightColor,
    settings.obstacleColor,
    settings.environmentLeftColor,
    settings.environmentRightColor,
    settings.environmentWhiteColor,
    settings.environmentLeftBoostColor,
    settings.environmentRightBoostColor,
    settings.environmentWhiteBoostColor,
  ]);

  useEffect(() => {
    const active = activeSelectionRef.current;
    if (skipInitialMenuEnvironment && active === null) return;
    const nextEnvironmentId = resolveEnvironmentId(
      active === null
        ? settings.overrideEnvironment
          ? settings.environmentOverrideId
          : 'BigMirrorEnvironment'
        : environmentForSettings(
            settings,
            active.mapEnvironmentId,
            active.replayEnvironmentId,
            active.usesChromaOrNoodle,
          ),
    );
    if (active?.environmentId === nextEnvironmentId) return;
    void selectEnvironment(nextEnvironmentId);
  }, [
    settings.preferReplayEnvironment,
    settings.useMapEnvironment,
    settings.overrideEnvironment,
    settings.environmentOverrideId,
    skipInitialMenuEnvironment,
  ]);

  function reportEnvironmentError(error: EnvironmentLoadFailure) {
    if (EnvironmentLoadAborted.is(error)) return;
    setError(`${t('errors.failedEnvironment')}: ${error.message}`);
  }

  async function selectEnvironment(nextEnvironmentId: string) {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    setError('');
    const active = activeSelectionRef.current;
    const result = await viewer.view.setEnvironment(nextEnvironmentId, active?.data.chromaEnvironment);
    if (result.isErr()) {
      reportEnvironmentError(result.error);
      return;
    }
    if (active !== null) {
      active.environmentId = nextEnvironmentId;
      viewer.view.refreshMapColors(
        colorOverride(settingsRef.current, active.mapColorScheme, replayRef.current?.metadata),
      );
    }
  }

  return { reportEnvironmentError };
}
