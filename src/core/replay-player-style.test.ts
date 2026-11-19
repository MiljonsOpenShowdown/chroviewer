import { expect, test } from 'vite-plus/test';

import { DEFAULT_REPLAY_PLAYER_STYLE, playerSaberSettings } from './replay-player-style';
import { DEFAULT_REPLAY_SABER_SETTINGS } from './viewer-settings';

test('uses the global saber settings without a saber style', () => {
  expect(playerSaberSettings(DEFAULT_REPLAY_SABER_SETTINGS, DEFAULT_REPLAY_PLAYER_STYLE)).toEqual(
    DEFAULT_REPLAY_SABER_SETTINGS,
  );
});

test('merges the player saber style over the global settings', () => {
  const global = { ...DEFAULT_REPLAY_SABER_SETTINGS, saberScale: 1.5, replayTrailLength: 0.5 };
  const merged = playerSaberSettings(global, {
    ...DEFAULT_REPLAY_PLAYER_STYLE,
    saber: { saberModel: 'ko-circles', replayTrailLength: 0.2 },
  });
  expect(merged).toEqual({ ...global, saberModel: 'ko-circles', replayTrailLength: 0.2 });
});

test('saber opacity multiplies the trail opacity', () => {
  const global = { ...DEFAULT_REPLAY_SABER_SETTINGS, replayTrailOpacity: 1.5 };
  expect(playerSaberSettings(global, { ...DEFAULT_REPLAY_PLAYER_STYLE, saberOpacity: 0.5 }).replayTrailOpacity).toBe(
    0.75,
  );
  expect(
    playerSaberSettings(global, {
      ...DEFAULT_REPLAY_PLAYER_STYLE,
      saber: { replayTrailOpacity: 0.4 },
      saberOpacity: 0.5,
    }).replayTrailOpacity,
  ).toBe(0.2);
});

test('player visibility only hides on top of the global settings', () => {
  const hiddenGlobally = { ...DEFAULT_REPLAY_SABER_SETTINGS, showSabers: false, showSaberTrails: false };
  expect(playerSaberSettings(hiddenGlobally, DEFAULT_REPLAY_PLAYER_STYLE)).toMatchObject({
    showSabers: false,
    showSaberTrails: false,
  });
  expect(
    playerSaberSettings(DEFAULT_REPLAY_SABER_SETTINGS, {
      ...DEFAULT_REPLAY_PLAYER_STYLE,
      showSabers: false,
      showTrails: true,
    }),
  ).toMatchObject({ showSabers: false, showSaberTrails: true });
});
