import type { BeatmapParser } from '../../core/beatmap/worker/client';
import type { MultiviewRendererHost } from '../../renderer/multiview-renderer-host';
import type { LiveMapCache } from '../live/live-map-cache';
import type { LiveStatus } from '../live/live-types';
import type { MultiviewReplayScore } from '../multiview/multiview-protocol';
import type { MultiviewStartBarrier } from '../multiview/multiview-start-barrier';
import type { MultiviewTimeline } from '../multiview/multiview-timeline';
import type { MapMeta } from './viewer-types';

// Kept apart from viewer-shell so multiview and the overlay shell can use these
// types without bundling the full viewer UI.

export interface MultiviewPlaybackSnapshot {
  playerId: string;
  time: number;
  duration: number;
  beat: number;
  bpm: number;
  playing: boolean;
  status: LiveStatus;
  error: string;
  map: MapMeta | null;
  mapHash: string | null;
  /** The live TA stream (one play) the tile shows; null for a recorded replay or before one. */
  streamId: string | null;
  playbackRate: number;
  /** The score in the tile's replay at a song time (see MultiviewStateMessage's replayScore). */
  scoreAt(time: number): MultiviewReplayScore | null;
  seek(time: number): void;
  /**
   * The song times the tile can seek to without stalling: from its oldest
   * retained frame to just behind its newest. Null before it has any.
   */
  seekableRange(): { start: number; end: number } | null;
  play(): void;
  pause(): void;
  correctDrift(time: number): void;
}

/** One multiview tile, rendered into the shared multiview canvas. */
export interface MultiviewTileOptions {
  id: string;
  playerId: string;
  /** Recorded replay to play instead of the player's live TA stream. */
  replayUrl?: string;
  host: MultiviewRendererHost;
  masterVolume: number;
  hitsoundVolume: number;
  disableGameUI: boolean;
  hidePlatform: boolean;
  lights: 'full' | 'static' | 'none';
  timeline: MultiviewTimeline;
  startBarrier: MultiviewStartBarrier;
  settings?: Record<string, string | number | boolean>;
  mapCache: LiveMapCache;
  parser: BeatmapParser;
  onPlayback(snapshot: MultiviewPlaybackSnapshot): void;
}

export interface MultiviewTileProps {
  multiview: MultiviewTileOptions;
}
