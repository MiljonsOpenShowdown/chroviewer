import { Result } from 'better-result';
import { z } from 'zod';

import { env } from '../../env';
import { extractMapArchive } from '../archive';
import { requestArrayBuffer, requestJson } from '../http';
import { browserMapArchiveCache, type MapArchiveCache } from '../map-archive-cache';
import { SourceError } from '../source-error';
import type { BeatSaverMapSource, DownloadProgressHandler, FetchRequest, SourceResult } from '../source-types';
import type { GetMapByIdData } from './generated/api-contracts';

interface ResolveOptions {
  cache?: MapArchiveCache | null;
  onProgress?: DownloadProgressHandler;
  request?: FetchRequest;
  signal?: AbortSignal;
}

type BeatSaverVersionContract = Required<Pick<NonNullable<GetMapByIdData['versions']>[number], 'downloadURL' | 'hash'>>;

type BeatSaverMapContract = Required<Pick<GetMapByIdData, 'id'>> & {
  versions: [BeatSaverVersionContract, ...BeatSaverVersionContract[]];
};

const beatSaverVersionSchema = z.object({
  hash: z.hash('sha1'),
  downloadURL: z.url(),
});

const beatSaverMapSchema: z.ZodType<BeatSaverMapContract> = z.object({
  id: z.string().min(1),
  versions: z.tuple([beatSaverVersionSchema], beatSaverVersionSchema),
});

const preparedHashSources = new Map<string, BeatSaverMapSource>();
const preparedHashSourceLimit = 2;

function preparedHashSource(hash: string) {
  const key = hash.toLowerCase();
  const source = preparedHashSources.get(key);
  if (source === undefined) return null;
  preparedHashSources.delete(key);
  preparedHashSources.set(key, source);
  return source;
}

function retainPreparedHashSource(source: BeatSaverMapSource) {
  const key = source.hash.toLowerCase();
  preparedHashSources.delete(key);
  preparedHashSources.set(key, source);
  while (preparedHashSources.size > preparedHashSourceLimit) {
    const oldest = preparedHashSources.keys().next().value;
    if (oldest === undefined) break;
    preparedHashSources.delete(oldest);
  }
}

export function beatSaverKey(input: string) {
  const value = input.trim();
  if (/^[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  const normalized = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  if (!URL.canParse(normalized)) return null;
  const url = new URL(normalized);
  if (!/(^|\.)beatsaver\.com$/i.test(url.hostname)) return null;
  return /\/(?:maps|beatmap)\/([0-9a-f]+)/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
}

export function fetchBeatSaverMap(input: string, options: ResolveOptions = {}) {
  const key = beatSaverKey(input);
  return key === null
    ? Promise.resolve(
        Result.err(
          new SourceError({
            message: 'enter a BeatSaver key or map URL',
            source: 'beatsaver',
            operation: 'parse-map-reference',
          }),
        ),
      )
    : fetchBeatSaver(`/maps/id/${key}`, `BeatSaver map ${key}`, options);
}

export async function fetchBeatSaverHash(hash: string, options: ResolveOptions = {}) {
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    return Result.err(
      new SourceError({
        message: 'invalid Beat Saber map hash',
        source: 'beatsaver',
        operation: 'parse-map-hash',
      }),
    );
  }
  const prepared = preparedHashSource(hash);
  if (prepared !== null) {
    options.onProgress?.(1);
    return Result.ok(prepared);
  }
  const cached = await cachedBeatSaverSource(hash, options);
  const result =
    cached === null ? fetchBeatSaver(`/maps/hash/${hash}`, `BeatSaver hash ${hash}`, options, true) : Result.ok(cached);
  const resolved = await result;
  if (resolved.isOk()) retainPreparedHashSource(resolved.value);
  return resolved;
}

async function cachedBeatSaverSource(hash: string, options: ResolveOptions) {
  const cache = options.cache === undefined ? browserMapArchiveCache : options.cache;
  if (cache === null) return null;
  const cached = await cache.get(hash);
  if (cached.isErr() || cached.value === null) return null;
  const source = await mapSourceFromArchive(cached.value.key, cached.value.hash, cached.value.archive);
  if (source.isErr()) return null;
  options.onProgress?.(1);
  return source.value;
}

async function fetchBeatSaver(
  path: string,
  label: string,
  options: ResolveOptions,
  cacheChecked = false,
): Promise<SourceResult<BeatSaverMapSource>> {
  const metadata = await Result.gen(async function* () {
    const response = yield* Result.await(
      requestJson(`${env.VITE_BEATSAVER_API_URL}${path}`, beatSaverMapSchema, {
        ...options,
        source: 'beatsaver',
        label,
        operation: 'load-map-metadata',
      }),
    );
    const version = response.versions[0];
    return Result.ok({ response, version });
  });
  if (metadata.isErr()) return Result.err(metadata.error);
  const { response, version } = metadata.value;

  const resolveVersion = (checkCache = !cacheChecked) =>
    Result.gen(async function* () {
      if (checkCache) {
        const cached = await cachedBeatSaverSource(version.hash, options);
        if (cached !== null) return Result.ok(cached);
      }
      const archive = yield* Result.await(
        requestArrayBuffer(version.downloadURL, {
          ...options,
          source: 'beatsaver',
          label: `BeatSaver download ${response.id}`,
          operation: 'download-map-archive',
        }),
      );
      const source = yield* Result.await(mapSourceFromArchive(response.id, version.hash, archive));
      const cache = options.cache === undefined ? browserMapArchiveCache : options.cache;
      if (cache !== null) await cache.set({ key: source.key, hash: source.hash, archive });
      return Result.ok(source);
    });

  // OPFS is shared by same-origin iframe documents, but an empty cache alone
  // does not stop four simultaneous viewers from all downloading and extracting
  // the same archive. A Web Lock makes the cold load single-flight across those
  // documents; waiters re-check OPFS after the first viewer commits the file.
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const defaultSharedCache = options.cache === undefined && browserMapArchiveCache !== null;
  if (locks === undefined || !defaultSharedCache) return resolveVersion();
  return locks.request(`chroviewer-map-${version.hash.toLowerCase()}`, { signal: options.signal }, () =>
    resolveVersion(true),
  );
}

async function mapSourceFromArchive(key: string, hash: string, archive: ArrayBuffer) {
  const files = await extractMapArchive(new Uint8Array(archive));
  if (files.isErr()) return Result.err(files.error);
  if (!files.value.some((file) => file.name.toLowerCase() === 'info.dat')) {
    return Result.err(
      new SourceError({
        message: `BeatSaver map ${key} archive has no Info.dat`,
        source: 'beatsaver',
        operation: 'validate-map-archive',
      }),
    );
  }
  return Result.ok({ key, hash, files: files.value });
}
