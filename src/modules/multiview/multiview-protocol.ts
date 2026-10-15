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
}

/** Playback control for recorded replays. Applies to every replay tile at once. */
export interface MultiviewControlMessage {
  type: 'beatkhana:multiview-control';
  version: 1;
  action: 'play' | 'pause' | 'seek';
  /** Song time in seconds, required for `seek`. */
  time?: number;
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
    status: string;
    time: number;
  }>;
}

export interface MultiviewReadyMessage {
  type: 'beatkhana:multiview-ready';
  version: 1;
}
