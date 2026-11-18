import { Result } from 'better-result';
import { describe, expect, test } from 'vite-plus/test';

import { SourceError } from '../../sources/source-error';
import type { BeatSaverMapSource, SourceResult } from '../../sources/source-types';
import { LiveMapCache } from './live-map-cache';

describe('LiveMapCache', () => {
  test('deduplicates concurrent loads of the same map', async () => {
    const cache = new LiveMapCache();
    const source: BeatSaverMapSource = { key: 'abc', hash: 'ABCDEF', files: [] };
    let resolveLoad: ((value: SourceResult<BeatSaverMapSource>) => void) | undefined;
    let loads = 0;
    const load = () => {
      loads++;
      return new Promise<SourceResult<BeatSaverMapSource>>((resolve) => {
        resolveLoad = resolve;
      });
    };

    const first = cache.getOrLoad(source.hash, load);
    const second = cache.getOrLoad(source.hash.toLowerCase(), load);
    expect(first).toBe(second);
    expect(loads).toBe(1);
    expect(cache.has(source.hash)).toBe(true);

    resolveLoad?.(Result.ok(source));
    await first;
    expect(cache.get(source.hash)).toBe(source);
  });

  test('remembers a failed load for the cooldown, and clears it on success', async () => {
    const cache = new LiveMapCache();
    const source: BeatSaverMapSource = { key: 'abc', hash: 'ABCDEF', files: [] };
    const failure = Result.err(
      new SourceError({ message: 'rate limited', source: 'beatsaver', operation: 'load-map-metadata' }),
    );

    await cache.getOrLoad(source.hash, () => Promise.resolve(failure));
    expect(cache.has(source.hash)).toBe(false);
    expect(cache.recentlyFailed(source.hash.toLowerCase())).toBe(true);
    expect(cache.recentlyFailed(source.hash, Date.now() + 60_000)).toBe(false);

    await cache.getOrLoad(source.hash, () => Promise.resolve(Result.ok(source)));
    expect(cache.recentlyFailed(source.hash)).toBe(false);
  });
});
