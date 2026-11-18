import * as z from 'zod/mini';

import { isRemoteSourceUrl } from '../viewer/viewer-search';

const idListInputSchema = z.union([z.string(), z.pipe(z.int(), z.transform(String))]);
// Comma list of numeric score IDs; a single bad ID drops the whole list
const scoreIdListSchema = z.pipe(
  z.pipe(
    idListInputSchema,
    z.transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    ),
  ),
  z.array(z.string().check(z.regex(/^\d+$/))),
);
// URLs may contain commas, so they are never split: repeat the replayUrl parameter instead
const replayUrlSchema = z.string().check(z.refine(isRemoteSourceUrl));
const mapKeySchema = z.pipe(
  z.string().check(z.regex(/^[0-9a-f]+$/i)),
  z.transform((value) => value.toLowerCase()),
);

export const brSearchSchema = z.pipe(
  z.object({
    ss: z.catch(z.optional(scoreIdListSchema), undefined),
    bl: z.catch(z.optional(scoreIdListSchema), undefined),
    // The router only keeps the first repeated parameter under replayUrl (see parseUrlSearch);
    // it also hands every repeated value over as replayUrls.
    replayUrl: z.catch(z.optional(z.union([replayUrlSchema, z.array(replayUrlSchema)])), undefined),
    replayUrls: z.catch(z.optional(z.array(replayUrlSchema)), undefined),
    // BeatSaver key or map hash the replays are expected to be on
    map: z.catch(z.optional(mapKeySchema), undefined),
  }),
  z.transform((search) => ({
    ss: search.ss ?? [],
    bl: search.bl ?? [],
    replayUrls:
      search.replayUrls ??
      (search.replayUrl === undefined ? [] : Array.isArray(search.replayUrl) ? search.replayUrl : [search.replayUrl]),
    map: search.map,
  })),
);

export type BrSearch = z.infer<typeof brSearchSchema>;

export type BrEntry =
  | { kind: 'scoresaber'; id: string }
  | { kind: 'beatleader'; id: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File };

// Player order is ScoreSaber IDs, then BeatLeader IDs, then replay URLs, then uploaded
// files, each in the order given. The URL cannot keep a mix of the kinds interleaved.
export function brEntriesFromSearch(search: Pick<BrSearch, 'ss' | 'bl' | 'replayUrls'>): BrEntry[] {
  return [
    ...search.ss.map((id): BrEntry => ({ kind: 'scoresaber', id })),
    ...search.bl.map((id): BrEntry => ({ kind: 'beatleader', id })),
    ...search.replayUrls.map((url): BrEntry => ({ kind: 'url', url })),
  ];
}

export function brEntryLabel(entry: BrEntry) {
  switch (entry.kind) {
    case 'scoresaber':
      return `ScoreSaber ${entry.id}`;
    case 'beatleader':
      return `BeatLeader ${entry.id}`;
    case 'url':
      return entry.url;
    case 'file':
      return entry.file.name;
  }
}
