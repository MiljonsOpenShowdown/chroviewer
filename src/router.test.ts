import { expect, test } from 'vite-plus/test';
import * as z from 'zod/mini';

import { viewerSearchSchema } from './modules/viewer/viewer-search';
import { parseUrlSearch } from './router';

test('canonicalizes the legacy replay trail shape before route validation', () => {
  const parsed = parseUrlSearch('?replayTrailShape=flag');

  expect(parsed.settings).toEqual({ replayTrailStyle: 'flag' });
  expect(z.parse(viewerSearchSchema, parsed).settings).toEqual(parsed.settings);
});

test('canonicalizes the legacy replay trail shape inside the settings object', () => {
  const settings = encodeURIComponent(JSON.stringify({ replayTrailShape: 'rectangle' }));
  const parsed = parseUrlSearch(`?settings=${settings}`);

  expect(parsed.settings).toEqual({ replayTrailStyle: 'rectangle' });
  expect(z.parse(viewerSearchSchema, parsed).settings).toEqual(parsed.settings);
});

test('parses isolated settings mode case-insensitively', () => {
  const parsed = parseUrlSearch('?ISOLATEDSETTINGS=true');

  expect(z.parse(viewerSearchSchema, parsed).isolatedSettings).toBe(true);
});

test('parses trail smoothing as a direct viewer setting', () => {
  const parsed = parseUrlSearch('?replayTrailSmoothing=false');

  expect(parsed.settings).toEqual({ replayTrailSmoothing: false });
  expect(z.parse(viewerSearchSchema, parsed).settings).toEqual(parsed.settings);
});

test('parses custom saber model aliases and canonical keys', () => {
  const alias = parseUrlSearch('?saber=euc');
  const canonical = parseUrlSearch('?saberModel=beatkhana');

  expect(alias.settings).toEqual({ saberModel: 'euc' });
  expect(canonical.settings).toEqual({ saberModel: 'beatkhana' });
  expect(z.parse(viewerSearchSchema, alias).settings).toEqual(alias.settings);
  expect(z.parse(viewerSearchSchema, canonical).settings).toEqual(canonical.settings);
});

test('selects CG5 through either per-player URL key and keeps other players independent', () => {
  const cg5 = z.parse(viewerSearchSchema, parseUrlSearch('?saber=cg5&leftColor=%2300ff00'));
  const canonical = z.parse(viewerSearchSchema, parseUrlSearch('?saberModel=cg5'));
  const euc = z.parse(viewerSearchSchema, parseUrlSearch('?saber=euc'));
  const compositorSettings = encodeURIComponent(JSON.stringify({ saberModel: 'cg5', rightColor: '#ffaa00' }));
  const nested = z.parse(viewerSearchSchema, parseUrlSearch(`?settings=${compositorSettings}`));

  expect(cg5.settings).toMatchObject({ saberModel: 'cg5', leftColor: '#00ff00' });
  expect(canonical.settings?.saberModel).toBe('cg5');
  expect(euc.settings?.saberModel).toBe('euc');
  expect(nested.settings).toMatchObject({ saberModel: 'cg5', rightColor: '#ffaa00' });
});

test('parses saber width as a per-viewer setting', () => {
  const parsed = parseUrlSearch('?saberWidth=0.72');

  expect(parsed.settings).toEqual({ saberWidth: 0.72 });
  expect(z.parse(viewerSearchSchema, parsed).settings).toEqual(parsed.settings);
});

test('preserves a serialized multi-map showcase configuration from a long browser-source URL', () => {
  const showcaseConfig = JSON.stringify({
    maps: Array.from({ length: 8 }, (_, index) => ({
      bpm: 124 + index,
      key: `4940${index}`,
      njs: 18,
      nps: 4.973,
      hash: String(index).repeat(40),
      name: `Showcase map ${index + 1}`,
      artist: 'Placeholder artist',
      mapper: 'Placeholder mapper',
      coverUrl: `https://cfcdn.beatsaver.com/${String(index).repeat(40)}.jpg`,
      reference: `4940${index}`,
      difficulty: 'ExpertPlus',
      characteristic: index === 1 ? 'Lightshow' : 'Standard',
      difficultyLabel: null,
      durationSeconds: 180 + index,
    })),
    loop: true,
    playbackMode: 'random',
    lastMap: null,
    targetAtMs: null,
  });
  const search = new URLSearchParams({
    showcase: 'true',
    hideUI: 'true',
    isolatedSettings: 'true',
    hidePlatform: 'true',
    qualityPreset: 'broadcast',
    showcaseConfig,
  });

  const parsed = parseUrlSearch(`?${search.toString()}`);
  const validated = z.parse(viewerSearchSchema, parsed);

  expect(validated.showcase).toBe(true);
  expect(validated.showcaseConfig).toBe(showcaseConfig);
  expect(validated.hidePlatform).toBe(true);
  expect(JSON.parse(validated.showcaseConfig ?? '{}').maps).toHaveLength(8);
});
