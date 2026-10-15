import { useEffect, useRef, useState, type RefObject } from 'react';

import { useTranslations } from 'use-intl';

import type { SongClock } from '../../core/clock/song-clock';
import type { LightshowMode } from '../../core/lighting/basic-light';
import { hitScoreVisualizerForSettings } from '../../core/replay/replay-display';
import type { Replay } from '../../core/replay/types';
import { colorOverride, type ViewerSettings } from '../../core/viewer-settings';
import { resolveEnvironmentId } from '../../renderer/environment/environment-catalog';
import { EnvironmentLoadAborted } from '../../renderer/environment/environment-error';
import type { MapView } from '../../renderer/map-view';
import type { MultiviewRendererHost, SharedViewerLifecycle } from '../../renderer/multiview-renderer-host';
import type { RenderPerformanceOptions } from '../../renderer/render-performance';
import type { RendererLifecycle } from '../../renderer/renderer-lifecycle';
import type { MultiviewTimeline } from '../multiview/multiview-timeline';
import type { ActiveSelection } from './viewer-types';

export interface ViewerHandle {
  view: MapView;
  lifecycle: RendererLifecycle | SharedViewerLifecycle;
}

interface ViewerRendererOptions {
  activeSelectionRef: RefObject<ActiveSelection | null>;
  clockRef: RefObject<SongClock | null>;
  lightshowModeRef: RefObject<LightshowMode>;
  replayRef: RefObject<Replay | null>;
  settings: ViewerSettings;
  settingsRef: RefObject<ViewerSettings>;
  performance: RenderPerformanceOptions;
  skipInitialMenuEnvironment: boolean;
  setError: (message: string) => void;
  sharedRenderer?: { host: MultiviewRendererHost; id: string };
  sharedTimeline?: { timeline: MultiviewTimeline; id: string };
}

function isCurrentViewer(viewerRef: RefObject<ViewerHandle | null>, view: MapView) {
  return viewerRef.current?.view === view;
}

export function useViewerRenderer({
  activeSelectionRef,
  clockRef,
  lightshowModeRef,
  replayRef,
  settings,
  settingsRef,
  performance,
  skipInitialMenuEnvironment,
  setError,
  sharedRenderer,
  sharedTimeline,
}: ViewerRendererOptions) {
  const t = useTranslations('viewer');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orthoOverlayRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const performanceRef = useRef(performance);
  performanceRef.current = performance;
  const initialEnvironmentLoadedRef = useRef(false);
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);

  useEffect(() => {
    const effect = new AbortController();
    let cleanup: (() => void) | null = null;

    async function initialize() {
      const [{ MapView }, { RendererLifecycle }] = await Promise.all([
        import('../../renderer/map-view'),
        import('../../renderer/renderer-lifecycle'),
      ]);
      const canvas = canvasRef.current;
      if (effect.signal.aborted || (canvas === null && sharedRenderer === undefined)) return;
      const active = activeSelectionRef.current;
      const initialPerformance = performanceRef.current;
      const lifecycle = sharedRenderer === undefined ? new RendererLifecycle(initialPerformance) : null;
      if (lifecycle !== null && canvas !== null) {
        lifecycle.attach(canvas);
        lifecycle.setRenderScale(settings.renderScale);
      }
      const finishInitialEnvironmentLoad = () => {
        if (initialEnvironmentLoadedRef.current) return;
        initialEnvironmentLoadedRef.current = true;
        setEnvironmentLoading(false);
      };
      const view = new MapView(
        { mirrorQuality: settings.graphicsQuality },
        finishInitialEnvironmentLoad,
        initialPerformance,
        () => orthoOverlayRef.current,
      );
      const lifecycleControls =
        lifecycle ?? sharedRenderer?.host.register(sharedRenderer.id, view, initialPerformance, settings.renderScale);
      if (lifecycleControls === undefined) return;
      lifecycle?.setView(view);
      if (active === null && !skipInitialMenuEnvironment) {
        view.startMenuLightshow(Math.floor(Math.random() * 0x1_0000_0000));
      } else {
        view.setLightshowMode(active === null ? 'static' : lightshowModeRef.current);
      }
      view.setReplayCameraSettings(settings);
      view.setReplaySaberSettings(settingsRef.current);
      view.setScreenDisplacementEffects(settingsRef.current.screenDisplacementEffects);
      view.setPreviewHitNotes(settingsRef.current.previewHitNotes);
      view.setPreviewHitLine(settingsRef.current.previewHitLine);
      view.setPreviewNotesLookAtPlayer(settingsRef.current.previewNotesLookAtPlayer);
      viewerRef.current = { view, lifecycle: lifecycleControls };
      setViewerReady(true);
      cleanup = () => {
        setViewerReady(false);
        viewerRef.current = null;
        if (sharedRenderer !== undefined) sharedRenderer.host.unregister(sharedRenderer.id, view);
        view.dispose();
        lifecycle?.dispose();
      };

      const initialLoad = !initialEnvironmentLoadedRef.current;
      if (initialLoad && skipInitialMenuEnvironment && active === null) {
        finishInitialEnvironmentLoad();
        return;
      }
      if (initialLoad) setEnvironmentLoading(true);
      const environmentResult = await view.setEnvironment(
        active?.environmentId ??
          resolveEnvironmentId(
            settingsRef.current.overrideEnvironment
              ? settingsRef.current.environmentOverrideId
              : 'BigMirrorEnvironment',
          ),
        active?.data.chromaEnvironment,
      );
      if (!isCurrentViewer(viewerRef, view)) return;
      if (environmentResult.isErr() && !EnvironmentLoadAborted.is(environmentResult.error)) {
        finishInitialEnvironmentLoad();
        const fallback = initialLoad ? t('errors.failedEnvironment') : t('errors.failedQualityRebuild');
        setError(`${fallback}: ${environmentResult.error.message}`);
      }

      function restoreActiveView(selection: ActiveSelection) {
        view.setMap(
          selection.data,
          colorOverride(settingsRef.current, selection.mapColorScheme, replayRef.current?.metadata),
        );
        view.setReplay(replayRef.current, hitScoreVisualizerForSettings(settingsRef.current, replayRef.current));
        view.setBeatSource(
          // Prefer the local high-resolution clock. Shared timeline samples are
          // intentionally only a fallback while a clock is being installed.
          () => clockRef.current?.currentBeat() ?? sharedTimeline?.timeline.beatFor(sharedTimeline.id) ?? 0,
        );
      }

      const clock = clockRef.current;
      if (active !== null && clock !== null) restoreActiveView(active);
    }

    queueMicrotask(() => {
      void initialize();
    });

    return () => {
      effect.abort();
      cleanup?.();
      cleanup = null;
    };
  }, [
    settings.graphicsQuality,
    sharedRenderer?.host,
    sharedRenderer?.id,
    sharedTimeline?.id,
    sharedTimeline?.timeline,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    viewer.lifecycle.setPerformance(performance);
    if (sharedRenderer === undefined) viewer.view.setRenderPerformance(performance);
  }, [
    performance.maxFps,
    performance.msaaSamples,
    performance.mirrorResolution,
    performance.mirrorMsaaSamples,
    performance.postBloomWidth,
    performance.bloomFogSize,
    performance.outputWidth,
    performance.outputHeight,
  ]);

  return { canvasRef, environmentLoading, orthoOverlayRef, viewerReady, viewerRef };
}
