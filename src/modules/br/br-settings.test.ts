import { expect, test } from 'vite-plus/test';

import type { PlayerColors } from '../../core/player-colors';
import type { Replay } from '../../core/replay/types';
import {
  brPlayerKey,
  brPlayerStyle,
  DEFAULT_BR_PLAYER_OVERRIDES,
  loadBrSettings,
  MAX_BR_NAME_LENGTH,
  rgbToHex,
  sanitizeBrSettings,
  saveBrSettings,
} from './br-settings';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

test('falls back to defaults for missing, invalid or unparsable settings', () => {
  const defaults = { orthoZoom: 1, players: {} };
  expect(sanitizeBrSettings(undefined)).toEqual(defaults);
  expect(sanitizeBrSettings('nope')).toEqual(defaults);
  expect(loadBrSettings(memoryStorage())).toEqual(defaults);
  expect(loadBrSettings(memoryStorage({ 'chroviewer.br-settings.v1': '{broken' }))).toEqual(defaults);
});

test('clamps the ortho zoom', () => {
  expect(sanitizeBrSettings({ orthoZoom: 99 }).orthoZoom).toBe(4);
  expect(sanitizeBrSettings({ orthoZoom: 0 }).orthoZoom).toBe(0.5);
  expect(sanitizeBrSettings({ orthoZoom: 'x' }).orthoZoom).toBe(1);
});

test('sanitizes each field of player overrides', () => {
  const settings = sanitizeBrSettings({
    players: {
      'id:1': {
        leftColor: '#ABCDEF',
        rightColor: 'red',
        name: 'x'.repeat(100),
        showSabers: false,
        showTrails: 'yes',
        saber: { saberModel: 'ko-circles', saberScale: 10, showSabers: false, hsvProfile: 'x' },
      },
      'id:2': 'not an object',
    },
  });
  expect(settings.players['id:1']).toEqual({
    ...DEFAULT_BR_PLAYER_OVERRIDES,
    leftColor: '#abcdef',
    name: 'x'.repeat(MAX_BR_NAME_LENGTH),
    showSabers: false,
    saber: { saberModel: 'ko-circles', saberScale: 3 },
  });
  expect(settings.players['id:2']).toEqual(DEFAULT_BR_PLAYER_OVERRIDES);
});

test('saves only players with overrides and loads them back', () => {
  const storage = memoryStorage();
  const custom = { ...DEFAULT_BR_PLAYER_OVERRIDES, name: 'Hawk', saber: { saberWidth: 2 } };
  saveBrSettings({ orthoZoom: 2, players: { 'id:1': custom, 'id:2': DEFAULT_BR_PLAYER_OVERRIDES } }, storage);
  expect(loadBrSettings(storage)).toEqual({ orthoZoom: 2, players: { 'id:1': custom } });
});

test('ignores storage that throws', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  expect(loadBrSettings(throwing)).toEqual({ orthoZoom: 1, players: {} });
  expect(() => {
    saveBrSettings({ orthoZoom: 1, players: {} }, throwing);
  }).not.toThrow();
});

test('keys players by platform ID, falling back to the entry label', () => {
  const replay = (id?: string) => ({ metadata: { player: id === undefined ? undefined : { id, name: id } } }) as Replay;
  expect(brPlayerKey({ label: 'a.bsor', replay: replay('76561198000000000') })).toBe('id:76561198000000000');
  expect(
    brPlayerKey({
      label: 'ScoreSaber 1',
      profile: { id: '1', name: 'A', avatar: '', country: '' },
      replay: replay('2'),
    }),
  ).toBe('id:1');
  expect(brPlayerKey({ label: 'a.bsor', replay: replay() })).toBe('entry:a.bsor');
});

test('builds the renderer style from overrides', () => {
  const colors: PlayerColors = { left: [1, 0, 0], right: [0, 0, 1] };
  expect(brPlayerStyle(DEFAULT_BR_PLAYER_OVERRIDES, colors).colors).toBeNull();
  const style = brPlayerStyle({ ...DEFAULT_BR_PLAYER_OVERRIDES, leftColor: '#00ff00', showLabel: false }, colors);
  expect(style.colors).toEqual({ left: [0, 1, 0], right: [0, 0, 1] });
  expect(style.showLabel).toBe(false);
  expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
});
