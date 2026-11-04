import type { MultiviewRenderStats } from '../../renderer/multiview-renderer-host';

export interface MultiviewPlayerConfig {
  id: string;
  playerId: string;
  platformIds: string[];
  /**
   * HTTPS URL of a recorded replay. When set the tile plays this recording
   * instead of the player's live TA stream, and the parent drives playback
   * with `beatkhana:multiview-control`.
   */
  replayUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  masterVolume: number;
  hitsoundVolume: number;
  disableGameUI: boolean;
  hidePlatform?: boolean;
  lights: 'full' | 'static' | 'none';
  backgroundColor?: string;
  waitingColor?: string;
  waitingText?: string;
  settings: Record<string, string | number | boolean>;
  score: unknown;
}

export interface MultiviewConfigMessage {
  type: 'beatkhana:multiview-config';
  version: 1;
  players: MultiviewPlayerConfig[];
  /**
   * Map hashes to download ahead of time, e.g. a map that is loaded but not
   * started yet, so a live stream of it starts without waiting on BeatSaver.
   */
  preloadMapHashes?: string[];
}

/**
 * Playback control. `play`, `pause` and `seek` drive recorded replays (every
 * replay tile at once). `sync` moves the other live tiles to the anchor tile's
 * song time, or the nearest one each has data for. The anchor never moves.
 */
export interface MultiviewControlMessage {
  type: 'beatkhana:multiview-control';
  version: 1;
  action: 'play' | 'pause' | 'seek' | 'sync';
  /** Song time in seconds, required for `seek`. */
  time?: number;
  /** The tile id whose time the others follow, required for `sync`. */
  anchorId?: string;
}

export interface MultiviewStateMessage {
  type: 'beatkhana:multiview-state';
  version: 1;
  time: number;
  beat: number;
  duration: number;
  playing: boolean;
  mapHash: string | null;
  map: { title: string; subtitle: string; author: string; mapper: string } | null;
  players: Array<{
    id: string;
    playerId: string;
    platformIds: string[];
    score: unknown;
    /**
     * The tile's score from its own replay at `time`, in the realtime score's
     * field names: exact to the frame shown, where `score` (the parent's
     * realtime score cached by song time) can trail it. Null without a replay
     * or before its first score.
     */
    replayScore: MultiviewReplayScore | null;
    status: string;
    /** The live TA stream (one play) the tile shows; null for a recorded replay or before one. */
    streamId: string | null;
    time: number;
    /** The tile's playback speed; null before it has a playback. */
    playbackRate: number | null;
    /**
     * Seconds of frames the tile has past `time`, from its seekable range:
     * how close it is to stalling. Null before it has any.
     */
    bufferedAhead: number | null;
  }>;
}

export interface MultiviewReplayScore {
  score: number;
  accuracy: number;
  combo: number;
  maxCombo: number;
  notesMissed: number;
  badCuts: number;
  bombHits: number;
  /** The song time it is the score at. */
  songPosition: number;
}

export interface MultiviewReadyMessage {
  type: 'beatkhana:multiview-ready';
  version: 1;
}

/** Once a second, how the shared renderer keeps up, for profiling in the parent page. */
export interface MultiviewPerfMessage extends MultiviewRenderStats {
  type: 'beatkhana:multiview-perf';
  version: 1;
}
