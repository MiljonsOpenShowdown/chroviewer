import type { Rgb } from './colors';

/** Saber colours of one player in a multi-player view: one hue, a deeper left and a lighter right shade. */
export interface PlayerColors {
  left: Rgb;
  right: Rgb;
}

const goldenAngle = 137.508;

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const amount = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return lightness - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * Colours for the player at `index`. Hues step by the golden angle, so any number of players get well-separated
 * hues. Both sabers share the hue; left is the deeper shade and right the lighter one, so the hands stay apart.
 */
export function playerColors(index: number): PlayerColors {
  const hue = (index * goldenAngle) % 360;
  return { left: hslToRgb(hue, 1, 0.42), right: hslToRgb(hue, 1, 0.7) };
}
