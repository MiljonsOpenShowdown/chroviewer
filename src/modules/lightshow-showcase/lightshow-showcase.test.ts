import { describe, expect, test } from 'vite-plus/test';

import { planLightshow, resolveTimedLightshow, type LightshowShowcaseMap } from './lightshow-showcase';
import { parseLightshowShowcaseConfig } from './use-lightshow-showcase';

const map = (key: string, durationSeconds: number): LightshowShowcaseMap => ({
  reference: key,
  key,
  hash: key.repeat(40).slice(0, 40),
  name: key,
  artist: '',
  mapper: '',
  coverUrl: '',
  durationSeconds,
  bpm: 120,
  characteristic: 'Lightshow',
  difficulty: 'ExpertPlus',
});

test('parses a serialized showcase query configuration', () => {
  const value = JSON.stringify({
    maps: [map('1', 120)],
    loop: false,
    playbackMode: 'order',
    lastMap: null,
    targetAtMs: null,
  });

  expect(parseLightshowShowcaseConfig(value)).toEqual({
    maps: [map('1', 120)],
    loop: false,
    playbackMode: 'order',
    lastMap: null,
    targetAtMs: null,
  });
});

test('rejects malformed showcase query configuration', () => {
  expect(parseLightshowShowcaseConfig('{not-json')).toBeNull();
  expect(parseLightshowShowcaseConfig(JSON.stringify({ maps: [{}] }))).toBeNull();
});

describe('planLightshow', () => {
  test('crops the first ordered map so the last song ends on target', () => {
    const plan = planLightshow(
      { maps: [map('3', 180), map('4', 240)], loop: true, playbackMode: 'order', lastMap: null, targetAtMs: 300_000 },
      0,
    );
    expect(plan.entries.map((entry) => entry.map.key)).toEqual(['3', '4']);
    expect(plan.entries[0]?.startSeconds).toBe(120);
  });

  test('loops regular maps but includes the preset last map exactly once', () => {
    const plan = planLightshow(
      { maps: [map('a', 100)], loop: true, playbackMode: 'order', lastMap: map('last', 50), targetAtMs: 350_000 },
      0,
    );
    expect(plan.entries.map((entry) => entry.map.key)).toEqual(['a', 'a', 'a', 'last']);
    expect(plan.entries.filter((entry) => entry.map.key === 'last')).toHaveLength(1);
  });

  test('waits when a non-looping list is shorter than the countdown', () => {
    const plan = planLightshow(
      { maps: [map('a', 100)], loop: false, playbackMode: 'order', lastMap: map('last', 50), targetAtMs: 300_000 },
      0,
    );
    expect(plan.startAtMs).toBe(150_000);
    expect(plan.entries.map((entry) => entry.map.key)).toEqual(['a', 'last']);
  });

  test('removes the preset last map from the regular rotation', () => {
    const last = map('last', 50);
    const plan = planLightshow(
      { maps: [map('a', 100), last], loop: true, playbackMode: 'order', lastMap: last, targetAtMs: 250_000 },
      0,
    );
    expect(plan.entries.filter((entry) => entry.map.key === 'last')).toHaveLength(1);
    expect(plan.entries.at(-1)?.map.key).toBe('last');
  });
});

describe('resolveTimedLightshow', () => {
  test('adds download delay to the first map start offset', () => {
    const entries = [
      { map: map('a', 180), startSeconds: 60 },
      { map: map('b', 240), startSeconds: 0 },
    ];
    expect(resolveTimedLightshow(entries, 0, 12_000)).toEqual({ index: 0, startSeconds: 72 });
  });

  test('skips maps whose complete playback window elapsed while loading', () => {
    const entries = [
      { map: map('a', 30), startSeconds: 20 },
      { map: map('b', 40), startSeconds: 0 },
    ];
    expect(resolveTimedLightshow(entries, 0, 15_000)).toEqual({ index: 1, startSeconds: 5 });
  });

  test('returns no position once the countdown timeline has ended', () => {
    expect(resolveTimedLightshow([{ map: map('a', 10), startSeconds: 0 }], 0, 10_000)).toBeNull();
  });
});
