import * as z from 'zod/mini';

import { isRemoteSourceUrl } from '../viewer/viewer-search';

const idListInputSchema = z.union([z.string(), z.pipe(z.int(), z.transform(String))]);

function splitIdList(value: string) {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

// Comma list of numeric score IDs, kept as the URL writes it (ss=1,2); a single bad ID drops the whole list
const scoreIdListSchema = z.pipe(
  idListInputSchema,
  z.transform((value, context) => {
    const ids = splitIdList(value);
    if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) {
      context.issues.push({ code: 'custom', message: 'invalid score ID list', input: value });
      return z.NEVER;
    }
    return ids.join(',');
  }),
);
// URLs may contain commas, so they are never split: repeat the replayUrl parameter instead.
// One URL stays a string and several an array, the shapes parseUrlSearch gives them.
const replayUrlSchema = z.string().check(z.refine(isRemoteSourceUrl));
const replayUrlsSchema = z.pipe(
  z.union([replayUrlSchema, z.array(replayUrlSchema)]),
  z.transform((value) => (Array.isArray(value) && value.length === 1 ? value[0] : value)),
);
const mapKeySchema = z.pipe(
  z.string().check(z.regex(/^[0-9a-f]+$/i)),
  z.transform((value) => value.toLowerCase()),
);

// Keeps the shape of the URL, so validating its own output (as the router does when it rebuilds the URL) changes
// nothing; brEntriesFromSearch turns it into lists
export const brSearchSchema = z.object({
  ss: z.catch(z.optional(scoreIdListSchema), undefined),
  bl: z.catch(z.optional(scoreIdListSchema), undefined),
  replayUrl: z.catch(z.optional(replayUrlsSchema), undefined),
  // BeatSaver key or map hash the replays are expected to be on
  map: z.catch(z.optional(mapKeySchema), undefined),
});

export type BrSearch = z.infer<typeof brSearchSchema>;

export type BrEntry =
  | { kind: 'scoresaber'; id: string }
  | { kind: 'beatleader'; id: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File };

// Player order is ScoreSaber IDs, then BeatLeader IDs, then replay URLs, then uploaded
// files, each in the order given. The URL cannot keep a mix of the kinds interleaved.
export function brEntriesFromSearch(search: Pick<BrSearch, 'ss' | 'bl' | 'replayUrl'>): BrEntry[] {
  const replayUrls = search.replayUrl === undefined ? [] : [search.replayUrl].flat();
  return [
    ...splitIdList(search.ss ?? '').map((id): BrEntry => ({ kind: 'scoresaber', id })),
    ...splitIdList(search.bl ?? '').map((id): BrEntry => ({ kind: 'beatleader', id })),
    ...replayUrls.map((url): BrEntry => ({ kind: 'url', url })),
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
