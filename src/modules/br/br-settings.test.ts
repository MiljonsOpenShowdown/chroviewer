import { expect, test } from 'vite-plus/test';

import type { PlayerColors } from '../../core/player-colors';
import type { Replay } from '../../core/replay/types';
import { DEFAULT_REPLAY_SABER_SETTINGS } from '../../core/viewer-settings';
import {
  brPlayerKey,
  brPlayerKeys,
  brPlayerStyle,
  brSaberSettings,
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
  const defaults = { orthoZoom: 1, orthoView: 'back', hitScoresOnly: true, players: {} };
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

test('keeps a valid ortho main view and falls back to back', () => {
  expect(sanitizeBrSettings({ orthoView: 'left' }).orthoView).toBe('left');
  expect(sanitizeBrSettings({ orthoView: 'right' }).orthoView).toBe('right');
  expect(sanitizeBrSettings({ orthoView: 'top' }).orthoView).toBe('back');
});

test('defaults saber opacity to 1 and clamps it to 0-1', () => {
  const opacity = (saberOpacity: unknown) => sanitizeBrSettings({ players: { a: { saberOpacity } } }).players.a;
  expect(sanitizeBrSettings({ players: { a: {} } }).players.a?.saberOpacity).toBe(1);
  expect(opacity('x')?.saberOpacity).toBe(1);
  expect(opacity(0.25)?.saberOpacity).toBe(0.25);
  expect(opacity(-1)?.saberOpacity).toBe(0);
  expect(opacity(5)?.saberOpacity).toBe(1);
});

test('defaults hit scores only to on and keeps a saved off', () => {
  expect(sanitizeBrSettings({}).hitScoresOnly).toBe(true);
  expect(sanitizeBrSettings({ hitScoresOnly: 'no' }).hitScoresOnly).toBe(true);
  expect(sanitizeBrSettings({ hitScoresOnly: false }).hitScoresOnly).toBe(false);
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
  const custom = { ...DEFAULT_BR_PLAYER_OVERRIDES, name: 'Hawk', saber: { saberWidth: 2 }, saberOpacity: 0.5 };
  saveBrSettings(
    {
      orthoZoom: 2,
      orthoView: 'right',
      hitScoresOnly: false,
      players: { 'id:1': custom, 'id:2': DEFAULT_BR_PLAYER_OVERRIDES },
    },
    storage,
  );
  expect(loadBrSettings(storage)).toEqual({
    orthoZoom: 2,
    orthoView: 'right',
    hitScoresOnly: false,
    players: { 'id:1': custom },
  });
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
  expect(loadBrSettings(throwing)).toEqual({ orthoZoom: 1, orthoView: 'back', hitScoresOnly: true, players: {} });
  expect(() => {
    saveBrSettings({ orthoZoom: 1, orthoView: 'back', hitScoresOnly: true, players: {} }, throwing);
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

test('keys a player listed more than once per entry, keeping the first entry on the plain key', () => {
  const replay = (id?: string) => ({ metadata: { player: id === undefined ? undefined : { id, name: id } } }) as Replay;
  expect(brPlayerKeys([{ label: 'a.bsor', replay: replay('1') }])).toEqual(['id:1']);
  expect(
    brPlayerKeys([
      { label: 'a.bsor', replay: replay('1') },
      { label: 'b.bsor', replay: replay('2') },
      { label: 'c.bsor', replay: replay('1') },
      { label: 'x.bsor', replay: replay() },
      { label: 'd.bsor', replay: replay('1') },
      { label: 'x.bsor', replay: replay() },
    ]),
  ).toEqual(['id:1', 'id:2', 'id:1#2', 'entry:x.bsor', 'id:1#3', 'entry:x.bsor#2']);
});

test('gives two entries of one player independent overrides that both persist', () => {
  const replay = { metadata: { player: { id: '1', name: 'A' } } } as Replay;
  const [first = '', second = ''] = brPlayerKeys([
    { label: 'a.bsor', replay },
    { label: 'b.bsor', replay },
  ]);
  const storage = memoryStorage();
  saveBrSettings(
    {
      orthoZoom: 1,
      orthoView: 'back',
      hitScoresOnly: true,
      players: {
        [first]: { ...DEFAULT_BR_PLAYER_OVERRIDES, saberOpacity: 0.5 },
        [second]: { ...DEFAULT_BR_PLAYER_OVERRIDES, leftColor: '#00ff00' },
      },
    },
    storage,
  );
  const loaded = loadBrSettings(storage).players;
  expect(loaded['id:1']).toEqual({ ...DEFAULT_BR_PLAYER_OVERRIDES, saberOpacity: 0.5 });
  expect(loaded['id:1#2']).toEqual({ ...DEFAULT_BR_PLAYER_OVERRIDES, leftColor: '#00ff00' });
});

test('builds the renderer style from overrides', () => {
  const colors: PlayerColors = { left: [1, 0, 0], right: [0, 0, 1] };
  expect(brPlayerStyle(DEFAULT_BR_PLAYER_OVERRIDES, colors).colors).toBeNull();
  const style = brPlayerStyle({ ...DEFAULT_BR_PLAYER_OVERRIDES, leftColor: '#00ff00', showLabel: false }, colors);
  expect(style.colors).toEqual({ left: [0, 1, 0], right: [0, 0, 1] });
  expect(style.showLabel).toBe(false);
  expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
});

test('layers the MOS - Thin default between the Cosmetics sabers and the player style', () => {
  const colors: PlayerColors = { left: [1, 0, 0], right: [0, 0, 1] };
  expect(brPlayerStyle(DEFAULT_BR_PLAYER_OVERRIDES, colors).saber).toEqual({ saberModel: 'mos-cc' });
  expect(
    brPlayerStyle({ ...DEFAULT_BR_PLAYER_OVERRIDES, saber: { saberModel: 'ko-circles', saberWidth: 2 } }, colors).saber,
  ).toEqual({ saberModel: 'ko-circles', saberWidth: 2 });
  expect(brPlayerStyle({ ...DEFAULT_BR_PLAYER_OVERRIDES, saber: { saberWidth: 2 } }, colors).saber).toEqual({
    saberModel: 'mos-cc',
    saberWidth: 2,
  });
  expect(brSaberSettings({ ...DEFAULT_REPLAY_SABER_SETTINGS, saberModel: 'default', saberWidth: 1.5 })).toEqual({
    ...DEFAULT_REPLAY_SABER_SETTINGS,
    saberModel: 'mos-cc',
    saberWidth: 1.5,
  });
  expect(brPlayerStyle({ ...DEFAULT_BR_PLAYER_OVERRIDES, saberOpacity: 0.3 }, colors).saberOpacity).toBe(0.3);
});
