import * as z from 'zod/mini';

import type { Rgb } from '../../core/colors';
import type { PlayerSaberStyle, ReplayPlayerStyle } from '../../core/replay-player-style';
import { DEFAULT_REPLAY_SABER_SETTINGS, hexToRgb, viewerSettingsPatchSchema } from '../../core/viewer-settings';
import type { BrPlayer } from './br-load';

/** One player's Battle Royale overrides. Everything defaults to the global settings and generated colours. */
export interface BrPlayerOverrides {
  /** `#rrggbb`, or null for the generated colour. */
  leftColor: string | null;
  rightColor: string | null;
  /** Empty shows the resolved name. */
  name: string;
  showSabers: boolean;
  showTrails: boolean;
  showHeadset: boolean;
  showLabel: boolean;
  /** Merged over the Cosmetics saber settings, or null to use them as they are. */
  saber: PlayerSaberStyle | null;
}

export interface BrSettings {
  /** Zoom of the ortho main camera; 1 is the inset's framing. */
  orthoZoom: number;
  /** By brPlayerKey, so a player keeps their overrides on every Battle Royale page. */
  players: Record<string, BrPlayerOverrides>;
}

export const BR_ORTHO_ZOOM = { minimum: 0.5, maximum: 4, default: 1 } as const;
export const MAX_BR_NAME_LENGTH = 64;

export const DEFAULT_BR_PLAYER_OVERRIDES: BrPlayerOverrides = {
  leftColor: null,
  rightColor: null,
  name: '',
  showSabers: true,
  showTrails: true,
  showHeadset: true,
  showLabel: true,
  saber: null,
};

const DEFAULT_BR_SETTINGS: BrSettings = { orthoZoom: BR_ORTHO_ZOOM.default, players: {} };

const storageKey = 'chroviewer.br-settings.v1';
const hexPattern = /^#[0-9a-f]{6}$/i;
// Visibility has its own switches, so the saber style leaves those two out
const saberStyleKeys = Object.keys(DEFAULT_REPLAY_SABER_SETTINGS).filter(
  (key): key is keyof PlayerSaberStyle => key !== 'showSabers' && key !== 'showSaberTrails',
);

const hexColorSchema = z.catch(
  z.nullable(
    z.pipe(
      z.string().check(z.regex(hexPattern)),
      z.transform((value) => value.toLowerCase()),
    ),
  ),
  null,
);

// Reuses the viewer settings' clamping and fallbacks, keeping only the saber style keys
const saberStyleSchema = z.catch(
  z.nullable(
    z.pipe(
      viewerSettingsPatchSchema,
      z.transform((patch) => {
        const style: Record<string, unknown> = {};
        for (const key of saberStyleKeys) {
          if (patch[key] !== undefined) style[key] = patch[key];
        }
        return style as PlayerSaberStyle;
      }),
    ),
  ),
  null,
);

const playerOverridesSchema = z.catch(
  z.object({
    leftColor: hexColorSchema,
    rightColor: hexColorSchema,
    name: z.catch(
      z.pipe(
        z.string(),
        z.transform((value) => value.slice(0, MAX_BR_NAME_LENGTH)),
      ),
      '',
    ),
    showSabers: z.catch(z.boolean(), true),
    showTrails: z.catch(z.boolean(), true),
    showHeadset: z.catch(z.boolean(), true),
    showLabel: z.catch(z.boolean(), true),
    saber: saberStyleSchema,
  }),
  DEFAULT_BR_PLAYER_OVERRIDES,
);

const brSettingsSchema = z.catch(
  z.object({
    orthoZoom: z.pipe(
      z.catch(z.number(), BR_ORTHO_ZOOM.default),
      z.transform((value) => Math.min(Math.max(value, BR_ORTHO_ZOOM.minimum), BR_ORTHO_ZOOM.maximum)),
    ),
    players: z.catch(z.record(z.string(), playerOverridesSchema), {}),
  }),
  DEFAULT_BR_SETTINGS,
);

export function sanitizeBrSettings(value: unknown): BrSettings {
  return z.parse(brSettingsSchema, value);
}

function isDefaultOverrides(overrides: BrPlayerOverrides) {
  return JSON.stringify(overrides) === JSON.stringify(DEFAULT_BR_PLAYER_OVERRIDES);
}

export function loadBrSettings(storage: Pick<Storage, 'getItem'> = localStorage): BrSettings {
  try {
    const text = storage.getItem(storageKey);
    return text === null ? DEFAULT_BR_SETTINGS : sanitizeBrSettings(JSON.parse(text));
  } catch {
    return DEFAULT_BR_SETTINGS;
  }
}

export function saveBrSettings(settings: BrSettings, storage: Pick<Storage, 'setItem'> = localStorage) {
  // Players back on every default are dropped, so the store only grows with real overrides
  const players = Object.fromEntries(
    Object.entries(settings.players).filter(([, overrides]) => !isDefaultOverrides(overrides)),
  );
  try {
    storage.setItem(storageKey, JSON.stringify({ ...settings, players }));
  } catch {
    // Storage full or blocked: the overrides still apply for this page
  }
}

/**
 * Stable key of a player's overrides. ScoreSaber, BeatLeader and TournamentAssistant files all name Steam players by
 * their Steam ID, so one ID key matches the same player whatever the source; without an ID, the entry label (URL or
 * file name) is the best there is.
 */
export function brPlayerKey(player: Pick<BrPlayer, 'label' | 'profile' | 'replay'>) {
  const id = player.profile?.id ?? player.replay.metadata.player?.id;
  return id !== undefined && id.trim() !== '' ? `id:${id.trim()}` : `entry:${player.label}`;
}

export function rgbToHex(color: Rgb) {
  return `#${color
    .map((channel) =>
      Math.round(Math.min(Math.max(channel, 0), 1) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The renderer style of a player's overrides; `generated` are their generated colours. */
export function brPlayerStyle(overrides: BrPlayerOverrides, generated: { left: Rgb; right: Rgb }): ReplayPlayerStyle {
  return {
    colors:
      overrides.leftColor === null && overrides.rightColor === null
        ? null
        : {
            left: overrides.leftColor === null ? generated.left : hexToRgb(overrides.leftColor),
            right: overrides.rightColor === null ? generated.right : hexToRgb(overrides.rightColor),
          },
    saber: overrides.saber,
    showSabers: overrides.showSabers,
    showTrails: overrides.showTrails,
    showHeadset: overrides.showHeadset,
    showLabel: overrides.showLabel,
  };
}
