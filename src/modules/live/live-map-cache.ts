import type { BeatSaverMapSource, SourceResult } from '../../sources/source-types';

const liveMapCacheSize = 2;
// The parent page re-posts its config (and its preload list) on every score
// update. Without a pause, a map that failed to load (e.g. BeatSaver answering
// 429) is requested again on each post, which keeps the rate limit going.
const failedLoadCooldownMs = 60_000;

export class LiveMapCache {
  private readonly maps = new Map<string, BeatSaverMapSource>();
  private readonly pending = new Map<string, Promise<SourceResult<BeatSaverMapSource>>>();
  private readonly failedAt = new Map<string, number>();

  has(hash: string) {
    const key = hash.toUpperCase();
    return this.maps.has(key) || this.pending.has(key);
  }

  /** Whether a load of this map failed within the cooldown, so a preload should wait. */
  recentlyFailed(hash: string, now = Date.now()) {
    const failed = this.failedAt.get(hash.toUpperCase());
    return failed !== undefined && now - failed < failedLoadCooldownMs;
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
    void request
      .then((result) => {
        if (result.isOk()) {
          this.failedAt.delete(key);
          this.set(result.value);
          return;
        }
        const now = Date.now();
        for (const [failedKey, failed] of this.failedAt) {
          if (now - failed >= failedLoadCooldownMs) this.failedAt.delete(failedKey);
        }
        this.failedAt.set(key, now);
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    return request;
  }
}
