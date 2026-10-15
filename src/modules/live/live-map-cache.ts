import type { BeatSaverMapSource, SourceResult } from '../../sources/source-types';

const liveMapCacheSize = 2;

export class LiveMapCache {
  private readonly maps = new Map<string, BeatSaverMapSource>();
  private readonly pending = new Map<string, Promise<SourceResult<BeatSaverMapSource>>>();

  has(hash: string) {
    const key = hash.toUpperCase();
    return this.maps.has(key) || this.pending.has(key);
  }

  get(hash: string) {
    const key = hash.toUpperCase();
    const source = this.maps.get(key);
    if (source === undefined) return undefined;
    this.maps.delete(key);
    this.maps.set(key, source);
    return source;
  }

  set(source: BeatSaverMapSource) {
    const key = source.hash.toUpperCase();
    this.maps.delete(key);
    this.maps.set(key, source);
    if (this.maps.size <= liveMapCacheSize) return;
    const oldest = this.maps.keys().next().value;
    if (oldest !== undefined) this.maps.delete(oldest);
  }

  getOrLoad(hash: string, load: () => Promise<SourceResult<BeatSaverMapSource>>) {
    const key = hash.toUpperCase();
    const current = this.pending.get(key);
    if (current !== undefined) return current;
    const request = load();
    this.pending.set(key, request);
    void request.then((result) => {
      if (result.isOk()) this.set(result.value);
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    return request;
  }
}
