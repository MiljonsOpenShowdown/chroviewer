import { createMemoryHistory } from '@tanstack/react-router';
import { expect, test } from 'vite-plus/test';
import * as z from 'zod/mini';

import { getRouter, parseUrlSearch, stringifyUrlSearch } from '../../router';
import { viewerSearchSchema } from '../viewer/viewer-search';
import { brEntriesFromSearch, brSearchSchema } from './br-search';

const urlA = 'https://example.com/a.bsor?x=1,2';
const urlB = 'https://example.com/b.bsor';
const replayUrlA = `replayUrl=${encodeURIComponent(urlA)}`;
const replayUrlB = `replayUrl=${encodeURIComponent(urlB)}`;

function parse(search: string) {
  return z.parse(brSearchSchema, parseUrlSearch(search));
}

// What the router writes back to the address bar after validating
function canonical(search: string) {
  return stringifyUrlSearch(parse(search));
}

test('keeps ss=1,2 as it is and gives both ScoreSaber entries', () => {
  const search = '?ss=95455666,93864781';
  expect(canonical(search)).toBe(search);
  expect(brEntriesFromSearch(parse(search))).toEqual([
    { kind: 'scoresaber', id: '95455666' },
    { kind: 'scoresaber', id: '93864781' },
  ]);
});

test('accepts repeated ss keys as legacy and normalizes them to a comma list', () => {
  const search = '?ss=95455666&ss=93864781';
  expect(canonical(search)).toBe('?ss=95455666,93864781');
  expect(brEntriesFromSearch(parse(search)).map((entry) => entry.kind)).toEqual(['scoresaber', 'scoresaber']);
});

test('keeps bl lists, drops a list with a bad ID', () => {
  expect(canonical('?bl=10,20')).toBe('?bl=10,20');
  expect(canonical('?bl=10&bl=20')).toBe('?bl=10,20');
  expect(parse('?ss=1,abc').ss).toBeUndefined();
  expect(parse('?ss=42').ss).toBe('42');
});

test('keeps two replayUrl parameters without adding another key', () => {
  const search = `?${replayUrlA}&${replayUrlB}`;
  expect(canonical(search)).toBe(search);
  expect(brEntriesFromSearch(parse(search))).toEqual([
    { kind: 'url', url: urlA },
    { kind: 'url', url: urlB },
  ]);
});

test('keeps mixed sources and orders entries as ScoreSaber, BeatLeader, then URLs', () => {
  const search = `?ss=1,2&bl=3&${replayUrlA}&map=abc1`;
  expect(canonical(search)).toBe(search);
  expect(brEntriesFromSearch(parse(search)).map((entry) => entry.kind)).toEqual([
    'scoresaber',
    'scoresaber',
    'beatleader',
    'url',
  ]);
});

test('validating its own output changes nothing', () => {
  for (const search of ['?ss=1,2', `?bl=3&${replayUrlA}&${replayUrlB}`, '?ss=1&map=abc1']) {
    const once = parse(search);
    expect(z.parse(brSearchSchema, once)).toEqual(once);
  }
});

test('/ still gets a single replayUrl string', () => {
  const single = parseUrlSearch(`?${replayUrlB}`);
  expect(single.replayUrl).toBe(urlB);
  expect(z.parse(viewerSearchSchema, single).replayUrl).toBe(urlB);
  // A repeated one plays the first, as before
  expect(z.parse(viewerSearchSchema, parseUrlSearch(`?${replayUrlB}&${replayUrlA}`)).replayUrl).toBe(urlB);
});

test('rejects replay URLs that are not remote sources, and lowercases the map key', () => {
  expect(parse('?replayUrl=http://example.com/a.bsor').replayUrl).toBeUndefined();
  expect(parse('?replayUrl=notaurl').replayUrl).toBeUndefined();
  expect(parse('?map=ABC1').map).toBe('abc1');
  expect(parse('?map=zz!').map).toBeUndefined();
});

// The server redirects to this location when it differs from the request; it used to drop every ID (bare /br)
test('the router builds the same /br location it was given', () => {
  for (const url of ['/br?ss=95455666,93864781', '/br?ss=95455666&ss=93864781', `/br?bl=1,2&${replayUrlA}`]) {
    const router = getRouter();
    router.update({ ...router.options, history: createMemoryHistory({ initialEntries: [url] }) });
    router.updateLatestLocation();
    const location = router.buildLocation({
      to: router.latestLocation.pathname,
      search: true,
      params: true,
      hash: true,
      state: true,
      _includeValidateSearch: true,
    } as Parameters<typeof router.buildLocation>[0]);
    expect(location.publicHref).toBe(router.latestLocation.publicHref);
    expect(brEntriesFromSearch(z.parse(brSearchSchema, location.search)).length).toBe(url.includes('bl=') ? 3 : 2);
  }
});
