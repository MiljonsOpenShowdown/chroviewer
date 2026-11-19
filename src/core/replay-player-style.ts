import type { PlayerColors } from './player-colors';
import type { ReplaySaberSettings } from './viewer-settings';

/** Saber and trail look a player can override; visibility is separate (ReplayPlayerStyle.showSabers/showTrails). */
export type PlayerSaberStyle = Partial<Omit<ReplaySaberSettings, 'showSabers' | 'showSaberTrails'>>;

/** How one player of a multi-player scene is drawn, on top of the global settings. */
export interface ReplayPlayerStyle {
  /** Replaces the player's generated colors, or null to keep them. */
  colors: PlayerColors | null;
  /** Merged over the global saber settings, or null to use them as they are. */
  saber: PlayerSaberStyle | null;
  showSabers: boolean;
  showTrails: boolean;
  showHeadset: boolean;
  showLabel: boolean;
  /** Fades the sabers and, on top of their own opacity, the trails; 0-1. */
  saberOpacity: number;
}

export const DEFAULT_REPLAY_PLAYER_STYLE: ReplayPlayerStyle = {
  colors: null,
  saber: null,
  showSabers: true,
  showTrails: true,
  showHeadset: true,
  showLabel: true,
  saberOpacity: 1,
};

/**
 * The global saber settings with the player's overrides on top; visibility can only hide, never show. The saber
 * opacity multiplies the trail opacity (the sabers themselves fade in the renderer).
 */
export function playerSaberSettings(global: ReplaySaberSettings, style: ReplayPlayerStyle): ReplaySaberSettings {
  const merged = { ...global, ...style.saber };
  return {
    ...merged,
    replayTrailOpacity: merged.replayTrailOpacity * style.saberOpacity,
    showSabers: global.showSabers && style.showSabers,
    showSaberTrails: global.showSaberTrails && style.showTrails,
  };
}
