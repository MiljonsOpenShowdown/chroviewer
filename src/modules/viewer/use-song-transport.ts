import { useEffect, useRef, useState, type RefObject } from 'react';

import { songBpmTimeToSeconds } from '../../core/beatmap/bpm';
import type { HitsoundEvent } from '../../core/clock/hitsounds';
import { createAudioClock, createSilentClock, type SongClock } from '../../core/clock/song-clock';
import type { LightshowMode } from '../../core/lighting/basic-light';
import type { ViewerSettings } from '../../core/viewer-settings';
import { useHitsoundPlayback } from './use-hitsound-playback';

interface LoadSongOptions {
  audioEnabled: boolean;
  audioData: ArrayBuffer | null;
  fallbackDuration: number;
  hitsoundEvents: HitsoundEvent[];
  onAudioDecodeError: () => void;
  shouldCommit?: () => boolean;
  songBpm: number;
  volume: number;
}

interface UseSongTransportOptions {
  lightshowModeRef: RefObject<LightshowMode>;
  settings: ViewerSettings;
  settingsRef: RefObject<ViewerSettings>;
}

interface RetainedAudioSource {
  audioData: ArrayBuffer | null;
  hitsoundEvents: HitsoundEvent[];
  onAudioDecodeError: () => void;
  songBpm: number;
}

export function useSongTransport({ lightshowModeRef, settings, settingsRef }: UseSongTransportOptions) {
  const clockRef = useRef<SongClock | null>(null);
  const autoplayRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const audioSwitchGenerationRef = useRef(0);
  const audioActiveRef = useRef(false);
  const audioProcessingEnabledRef = useRef(settings.masterVolume > 0);
  const transitionGainRef = useRef(1);
  const transitionFadeGenerationRef = useRef(0);
  const retainedAudioRef = useRef<RetainedAudioSource | null>(null);
  const songBpmRef = useRef(120);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [started, setStarted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [beatStepNumerator, setBeatStepNumerator] = useState(1);
  const [beatStepDenominator, setBeatStepDenominator] = useState(4);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const hitsounds = useHitsoundPlayback({
    enabled: settings.masterVolume > 0,
    audioOffset: settings.audioOffsetMs / 1000,
    clockRef,
    lightshowModeRef,
    settingsRef,
    volume: settings.masterMuted ? 0 : settings.masterVolume * settings.hitsoundVolume,
    hitsoundPreset: settings.hitsoundPreset,
    customGoodHitsound: settings.customGoodHitsound,
    customBadHitsound: settings.customBadHitsound,
  });
  const hitsoundsRef = useRef(hitsounds);
  hitsoundsRef.current = hitsounds;

  useEffect(() => {
    applyTransitionGain(transitionGainRef.current);
  }, [settings.masterMuted, settings.masterVolume, settings.songMuted, settings.songVolume]);

  useEffect(() => {
    clockRef.current?.setAudioOffset(settings.audioOffsetMs / 1000);
  }, [settings.audioOffsetMs]);

  useEffect(() => {
    const enabled = settings.masterVolume > 0;
    if (enabled === audioProcessingEnabledRef.current) return;
    audioProcessingEnabledRef.current = enabled;
    void setAudioProcessingEnabled(enabled);
  }, [settings.masterVolume]);

  useEffect(() => {
    let interval: number | null = null;

    function updateTransportState() {
      const clock = clockRef.current;
      if (clock === null) return;
      const currentSettings = settingsRef.current;
      setTime(clock.currentTime());
      setPlaying(clock.isPlaying());
      setAudioBlocked(
        autoplayRef.current &&
          !currentSettings.masterMuted &&
          !currentSettings.songMuted &&
          currentSettings.masterVolume > 0 &&
          currentSettings.songVolume > 0 &&
          clock.isPlaying() &&
          clock.audioBlocked(),
      );
    }

    function stopPolling() {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    }

    function startPolling() {
      if (interval !== null || document.hidden) return;
      updateTransportState();
      interval = window.setInterval(updateTransportState, 100);
    }

    function handleVisibilityChange() {
      if (document.hidden) stopPolling();
      else startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    startPolling();
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(
    () => () => {
      disposeClock();
    },
    [],
  );

  function disposeClock() {
    clockRef.current?.dispose();
    clockRef.current = null;
  }

  function songVolume(gain = transitionGainRef.current) {
    const currentSettings = settingsRef.current;
    return currentSettings.masterMuted || currentSettings.songMuted
      ? 0
      : currentSettings.masterVolume * currentSettings.songVolume * gain;
  }

  function applyTransitionGain(gain: number) {
    const clamped = Math.min(Math.max(gain, 0), 1);
    transitionGainRef.current = clamped;
    clockRef.current?.setVolume(songVolume(clamped));
    hitsoundsRef.current.setTransitionGain(clamped);
  }

  function setTransitionGain(gain: number) {
    transitionFadeGenerationRef.current++;
    applyTransitionGain(gain);
  }

  function fadeTransitionGain(target: number, durationMs: number) {
    const generation = ++transitionFadeGenerationRef.current;
    const from = transitionGainRef.current;
    const to = Math.min(Math.max(target, 0), 1);
    if (durationMs <= 0 || from === to) {
      applyTransitionGain(to);
      return Promise.resolve(true);
    }
    const startedAt = performance.now();
    return new Promise<boolean>((resolve) => {
      function step(now: number) {
        if (generation !== transitionFadeGenerationRef.current) {
          resolve(false);
          return;
        }
        const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
        const eased = progress * progress * (3 - 2 * progress);
        applyTransitionGain(from + (to - from) * eased);
        if (progress >= 1) resolve(true);
        else requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  function clear() {
    loadGenerationRef.current++;
    audioSwitchGenerationRef.current++;
    audioActiveRef.current = false;
    retainedAudioRef.current = null;
    hitsounds.clear();
    disposeClock();
    autoplayRef.current = false;
    setDuration(0);
    setTime(0);
    setStarted(false);
    setAudioBlocked(false);
    setPlaying(false);
  }

  async function load(options: LoadSongOptions) {
    const generation = ++loadGenerationRef.current;
    audioSwitchGenerationRef.current++;
    songBpmRef.current = options.songBpm;
    retainedAudioRef.current = {
      audioData: options.audioData,
      hitsoundEvents: options.hitsoundEvents,
      onAudioDecodeError: options.onAudioDecodeError,
      songBpm: options.songBpm,
    };
    let clock: SongClock;
    let audioDecodeFailed = false;
    const audioData = options.audioEnabled ? options.audioData : null;
    if (audioData === null) {
      clock = createSilentClock(options.fallbackDuration, options.songBpm);
    } else {
      const result = await createAudioClock({
        audioData,
        songBpm: options.songBpm,
        volume: options.volume,
      });
      if (result.isErr()) {
        clock = createSilentClock(options.fallbackDuration, options.songBpm);
        audioDecodeFailed = true;
      } else {
        clock = result.value;
      }
    }
    if (generation !== loadGenerationRef.current || options.shouldCommit?.() === false) {
      clock.dispose();
      return null;
    }
    const audioStillEnabled = settingsRef.current.masterVolume > 0;
    if (!audioStillEnabled && audioData !== null && !audioDecodeFailed) {
      clock.dispose();
      clock = createSilentClock(options.fallbackDuration, options.songBpm);
    }
    audioActiveRef.current = audioStillEnabled && audioData !== null && !audioDecodeFailed;
    disposeClock();
    if (audioDecodeFailed) options.onAudioDecodeError();
    clock.setAudioOffset(settingsRef.current.audioOffsetMs / 1000);
    clock.setRate(playbackRate);
    clock.setVolume(
      settingsRef.current.masterMuted || settingsRef.current.songMuted
        ? 0
        : settingsRef.current.masterVolume * settingsRef.current.songVolume * transitionGainRef.current,
    );
    clockRef.current = clock;
    autoplayRef.current = false;
    hitsounds.load(audioActiveRef.current ? options.hitsoundEvents : []);
    setDuration(clock.duration);
    setTime(0);
    setStarted(false);
    setAudioBlocked(false);
    setPlaying(false);
    return clock;
  }

  async function setAudioProcessingEnabled(enabled: boolean) {
    const generation = ++audioSwitchGenerationRef.current;
    const current = clockRef.current;
    if (!enabled) {
      hitsoundsRef.current.disable();
      setAudioBlocked(false);
      if (current === null || !audioActiveRef.current) return;
      const silent = createSilentClock(current.duration, songBpmRef.current);
      copyClockState(current, silent);
      clockRef.current = silent;
      audioActiveRef.current = false;
      current.dispose();
      return;
    }

    if (current === null || audioActiveRef.current) return;
    const source = retainedAudioRef.current;
    if (source?.audioData === null || source?.audioData === undefined) return;
    const currentSettings = settingsRef.current;
    const result = await createAudioClock({
      audioData: source.audioData,
      songBpm: source.songBpm,
      volume:
        currentSettings.masterMuted || currentSettings.songMuted
          ? 0
          : currentSettings.masterVolume * currentSettings.songVolume * transitionGainRef.current,
    });
    if (
      generation !== audioSwitchGenerationRef.current ||
      retainedAudioRef.current !== source ||
      settingsRef.current.masterVolume === 0
    ) {
      if (result.isOk()) result.value.dispose();
      return;
    }
    if (result.isErr()) {
      source.onAudioDecodeError();
      return;
    }
    const previous = clockRef.current;
    if (previous === null) {
      result.value.dispose();
      return;
    }
    copyClockState(previous, result.value);
    clockRef.current = result.value;
    audioActiveRef.current = true;
    previous.dispose();
    setDuration(result.value.duration);
    hitsoundsRef.current.load(source.hitsoundEvents);
    hitsoundsRef.current.seek(result.value.currentTime());
    if (result.value.isPlaying() && settingsRef.current.hitsounds) hitsoundsRef.current.resume();
  }

  function copyClockState(source: SongClock, target: SongClock) {
    const time = source.currentTime();
    const wasPlaying = source.isPlaying();
    target.setRate(source.getRate());
    target.setAudioOffset(settingsRef.current.audioOffsetMs / 1000);
    target.seek(time);
    if (wasPlaying) target.play();
  }

  function play({ autoplay = false }: { autoplay?: boolean } = {}) {
    const clock = clockRef.current;
    if (clock === null) return undefined;
    autoplayRef.current = autoplay;
    if (clock.isPlaying()) return true;
    if (clock.currentTime() >= clock.duration) {
      clock.seek(0);
      hitsounds.seek(0);
      setTime(0);
    }
    if (settings.masterVolume > 0 && settings.hitsounds) hitsounds.resume();
    clock.play();
    const nextPlaying = clock.isPlaying();
    setStarted(true);
    setAudioBlocked(false);
    setPlaying(nextPlaying);
    return nextPlaying;
  }

  function pause() {
    const clock = clockRef.current;
    if (clock === null) return false;
    if (clock.isPlaying()) clock.pause();
    autoplayRef.current = false;
    setAudioBlocked(false);
    setPlaying(false);
    return false;
  }

  function stop() {
    const clock = clockRef.current;
    if (clock === null) return;
    pause();
    clock.seek(0);
    hitsounds.seek(0);
    setTime(0);
    setStarted(false);
  }

  function togglePlay() {
    const clock = clockRef.current;
    if (clock === null) return undefined;
    return clock.isPlaying() ? pause() : play();
  }

  async function unlockAudio() {
    const clock = clockRef.current;
    if (clock === null) return false;
    const unlocked = await clock.unlockAudio();
    if (unlocked) autoplayRef.current = false;
    setAudioBlocked(!unlocked || clock.audioBlocked());
    return unlocked;
  }

  function seek(target: number) {
    const clock = clockRef.current;
    if (clock === null) return;
    const next = Math.min(Math.max(target, 0), clock.duration);
    clock.seek(next);
    hitsounds.seek(next);
    setTime(next);
  }

  function seekBeats(beats: number, songBpm: number) {
    const clock = clockRef.current;
    if (clock === null) return;
    seek(clock.currentTime() + songBpmTimeToSeconds(beats, songBpm));
  }

  function setHitsoundEvents(events: HitsoundEvent[]) {
    hitsounds.load(settingsRef.current.masterVolume > 0 ? events : []);
    hitsounds.seek(clockRef.current?.currentTime() ?? 0);
  }

  function setPlaybackRate(rate: number) {
    setPlaybackRateState(rate);
    clockRef.current?.setRate(rate);
  }

  return {
    audioBlocked,
    beatStepDenominator,
    beatStepNumerator,
    clear,
    clockRef,
    duration,
    ended: duration > 0 && time >= duration && !playing,
    fadeTransitionGain,
    load,
    playbackRate,
    pause,
    play,
    playing,
    seek,
    seekBeats,
    setBeatStepDenominator,
    setBeatStepNumerator,
    setHitsoundEvents,
    setPlaybackRate,
    setTransitionGain,
    started,
    stop,
    time,
    togglePlay,
    unlockAudio,
  };
}
