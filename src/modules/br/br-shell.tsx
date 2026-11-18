import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { useSearch } from '@tanstack/react-router';
import { AlertCircle, LoaderCircle, Play, RotateCcw, Volume2, X } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { replayScoreAt } from '../../core/replay/scoring';
import { environmentCatalog } from '../../renderer/environment/environment-catalog';
import { SettingsDrawer } from '../settings/settings-drawer';
import { ReplayOrthoOverlay } from '../viewer/components/replay-ortho-overlay';
import { ViewerActions } from '../viewer/components/viewer-actions';
import { ViewerOverlay } from '../viewer/components/viewer-overlay';
import { TransportControls } from '../viewer/transport/transport-controls';
import { useViewerControls } from '../viewer/use-viewer-controls';
import type { ViewerPanel } from '../viewer/viewer-types';
import type { BrSession } from './br-load';
import { BrPlayerPanel } from './br-player-panel';
import { BrSettingsTab } from './br-settings-tab';
import { useBrLoad } from './use-br-load';
import { useBrViewer } from './use-br-viewer';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function BrShell() {
  const t = useTranslations('br');
  const search = useSearch({ from: '/br' });
  const state = useBrLoad(search);

  if (state.status === 'ready') return <BrViewer session={state.session} />;
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-white">
      {state.status === 'loading' && <p>{t('loading', { loaded: state.loaded, total: state.total })}</p>}
      {state.status === 'error' && <p role="alert">{state.message}</p>}
    </main>
  );
}

// Every player on one map and one song clock, with the viewer's transport controls
function BrViewer({ session }: { session: BrSession }) {
  const t = useTranslations('viewer');
  const commonT = useTranslations('common');
  const viewer = useBrViewer(session);
  const { settings, setSettings, settingsRef, transport } = viewer;
  const [activePanel, setActivePanel] = useState<ViewerPanel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const triggerRef = useRef<HTMLElement | null>(null);
  const beatStep = transport.beatStepNumerator / transport.beatStepDenominator;
  const scores = viewer.timelines?.map((timeline) => replayScoreAt(timeline, transport.time)) ?? null;

  function toggleSettings(event: ReactMouseEvent<HTMLButtonElement>) {
    triggerRef.current = event.currentTarget;
    setActivePanel(null);
    setSettingsOpen((open) => !open);
  }

  function toggleHitsounds() {
    setSettings((current) => ({ ...current, hitsounds: !current.hitsounds }));
  }

  useViewerControls({
    activePanel,
    autoHide: settings.autoHide,
    beatStep,
    playing: transport.playing,
    transportReadOnly: false,
    setActivePanel,
    setChromeVisible,
    triggerRef,
    onSeekBeats: (beats) => {
      transport.seekBeats(beats, viewer.songBpm);
    },
    onToggleHitsounds: toggleHitsounds,
    onTogglePlay: transport.togglePlay,
  });

  const playbackOverlay =
    viewer.environmentLoading || (!viewer.ready && viewer.error === '')
      ? { icon: LoaderCircle, iconClassName: 'animate-spin', label: t('environmentLoading') }
      : !viewer.ready || transport.duration <= 0
        ? null
        : transport.ended
          ? {
              actionLabel: commonT('replay'),
              icon: RotateCcw,
              label: commonT('replay'),
              onAction: () => {
                transport.togglePlay();
              },
            }
          : !transport.started
            ? {
                actionLabel: commonT('play'),
                icon: Play,
                label: commonT('play'),
                onAction: () => {
                  transport.togglePlay();
                },
              }
            : null;

  return (
    <main className="relative size-full overflow-hidden bg-black">
      <canvas
        ref={viewer.canvasRef}
        className="absolute inset-0 size-full"
        onWheel={(event) => {
          if (!viewer.ready || event.deltaY === 0 || event.ctrlKey || event.metaKey) return;
          transport.seekBeats(Math.sign(event.deltaY) * beatStep, viewer.songBpm);
        }}
      />

      {/* The inset would repeat the ortho main camera */}
      {settings.orthoCameraEnabled && viewer.ready && !viewer.lightshowForced && !viewer.mainOrtho && (
        <ReplayOrthoOverlay
          overlayRef={viewer.orthoOverlayRef}
          view={settings.orthoCameraView}
          onViewChange={(orthoCameraView) => {
            setSettings((current) => ({ ...current, orthoCameraView }));
          }}
        />
      )}

      {playbackOverlay !== null && (
        <ViewerOverlay
          {...playbackOverlay}
          className={'onAction' in playbackOverlay ? 'bottom-16! max-sm:bottom-24!' : undefined}
        />
      )}

      {transport.audioBlocked && (
        <Button
          className="fixed bottom-16 left-1/2 z-40 -translate-x-1/2 cursor-pointer rounded-full shadow-xl backdrop-blur-xl max-sm:bottom-24"
          variant="outline"
          aria-label={t('clickToUnmute')}
          onClick={() => {
            void transport.unlockAudio();
          }}
        >
          <Volume2 />
          {t('clickToUnmute')}
        </Button>
      )}

      <BrPlayerPanel
        title={viewer.mapMeta?.title ?? null}
        players={viewer.players}
        scores={scores}
        focusedIndex={viewer.focusedIndex}
        visible={chromeVisible}
        onFocus={viewer.focusPlayer}
      />

      {/* Battle Royale pages have no share link (uploaded replays cannot be shared) */}
      <ViewerActions
        aboutOpen={activePanel === 'about'}
        aboutTriggerVisible
        chromeVisible={chromeVisible}
        hasMap={false}
        shareEnabled={false}
        settingsOpen={settingsOpen}
        shareCategories={[]}
        shareIncludeTimecode={false}
        shareOpen={false}
        shareUrl={null}
        onAboutOpenChange={(open) => {
          setActivePanel(open ? 'about' : null);
        }}
        onCopyShare={() => Promise.resolve(false)}
        onSettingsClick={toggleSettings}
        onShareCategoriesChange={() => undefined}
        onShareIncludeTimecodeChange={() => undefined}
        onShareOpenChange={() => undefined}
      />

      <TransportControls
        mode="playback"
        visible={chromeVisible}
        playing={transport.playing}
        ended={transport.ended}
        time={transport.time}
        duration={transport.duration}
        songBpm={viewer.songBpm}
        beatStepNumerator={transport.beatStepNumerator}
        beatStepDenominator={transport.beatStepDenominator}
        timelineShareUrl={null}
        timelineCopied={null}
        panel={
          activePanel === 'speed' || activePanel === 'lights' || activePanel === 'camera' || activePanel === 'volume'
            ? activePanel
            : null
        }
        playbackRate={transport.playbackRate}
        lightshowMode={viewer.lightshowMode}
        lightshowReadOnly={false}
        replayCamera={settings.replayCamera}
        orthoCameraEnabled={settings.orthoCameraEnabled}
        mainOrtho={{ enabled: viewer.mainOrtho, onChange: viewer.setMainOrtho }}
        hasReplay
        songMuted={settings.songMuted}
        masterMuted={settings.masterMuted}
        masterVolume={settings.masterVolume}
        songVolume={settings.songVolume}
        hitsounds={settings.hitsounds}
        hitsoundVolume={settings.hitsoundVolume}
        reverseTimelineScroll={settings.reverseTimelineScroll}
        markers={[]}
        onTogglePlay={() => {
          transport.togglePlay();
        }}
        onSeek={transport.seek}
        onSeekBeats={(beats) => {
          transport.seekBeats(beats, viewer.songBpm);
        }}
        onNumeratorChange={transport.setBeatStepNumerator}
        onDenominatorChange={transport.setBeatStepDenominator}
        // Battle Royale pages have no timeline share link (uploaded replays cannot be shared)
        onCopyTimeline={() => undefined}
        onPanelOpenChange={(panel, open) => {
          setActivePanel((current) => (open ? panel : current === panel ? null : current));
        }}
        onPlaybackRateChange={(rate) => {
          transport.setPlaybackRate(rate);
        }}
        onLightshowModeChange={viewer.changeLightshowMode}
        onReplayCameraChange={(replayCamera) => {
          setSettings((current) => ({ ...current, replayCamera }));
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
        onToggleMasterMuted={() => {
          if (settingsRef.current.masterMuted) void transport.unlockAudio();
          setSettings((current) => ({ ...current, masterMuted: !current.masterMuted }));
        }}
        onToggleSongMuted={() => {
          if (settingsRef.current.songMuted) void transport.unlockAudio();
          setSettings((current) => ({ ...current, songMuted: !current.songMuted }));
        }}
        onToggleHitsounds={toggleHitsounds}
      />

      {viewer.error !== '' && (
        <Alert
          className="fixed bottom-20 left-1/2 z-50 w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2"
          aria-live="assertive"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="text-destructive size-4 shrink-0" />
            {viewer.error}
          </span>
          <Button
            className="cursor-pointer"
            variant="ghost"
            size="icon-sm"
            aria-label={t('dismissError')}
            onClick={() => {
              viewer.setError('');
            }}
          >
            <X />
          </Button>
        </Alert>
      )}
      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        environments={environmentCatalog}
        hasReplay
        isMapPreview={false}
        onChange={setSettings}
        onClose={() => {
          setSettingsOpen(false);
        }}
        brTab={
          <BrSettingsTab
            players={viewer.settingsPlayers}
            settings={viewer.brSettings}
            sabers={settings}
            onChange={viewer.setBrSettings}
          />
        }
      />
    </main>
  );
}
