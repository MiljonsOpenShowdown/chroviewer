import { expect, test } from 'vite-plus/test';
import * as z from 'zod/mini';

import { parseUrlSearch } from '../../router';
import { brEntriesFromSearch, brSearchSchema } from './br-search';

function parse(search: string) {
  return z.parse(brSearchSchema, parseUrlSearch(search));
}

test('parses comma lists of score IDs in order', () => {
  const search = parse('?ss=3,1,2&bl=10,20');

  expect(search.ss).toEqual(['3', '1', '2']);
  expect(search.bl).toEqual(['10', '20']);
});

test('keeps a single numeric ID as a list', () => {
  expect(parse('?ss=42').ss).toEqual(['42']);
});

test('drops a list containing a non-numeric ID', () => {
  expect(parse('?ss=1,abc').ss).toEqual([]);
});

test('keeps repeated replayUrl parameters', () => {
  const search = parse(
    `?replayUrl=${encodeURIComponent('https://example.com/a.bsor?x=1,2')}&replayUrl=${encodeURIComponent('https://example.com/b.bsor')}`,
  );

  expect(search.replayUrls).toEqual(['https://example.com/a.bsor?x=1,2', 'https://example.com/b.bsor']);
});

test('accepts a single replayUrl', () => {
  expect(parse(`?replayUrl=${encodeURIComponent('https://example.com/a.bsor')}`).replayUrls).toEqual([
    'https://example.com/a.bsor',
  ]);
});

test('rejects replay URLs that are not remote sources', () => {
  expect(parse('?replayUrl=http://example.com/a.bsor').replayUrls).toEqual([]);
  expect(parse('?replayUrl=notaurl').replayUrls).toEqual([]);
});

test('lowercases the map key and ignores a malformed one', () => {
  expect(parse('?map=ABC1').map).toBe('abc1');
  expect(parse('?map=zz!').map).toBeUndefined();
});

test('orders entries as ScoreSaber, BeatLeader, then URLs', () => {
  const entries = brEntriesFromSearch({ ss: ['1'], bl: ['2'], replayUrls: ['https://example.com/a.bsor'] });

  expect(entries.map((entry) => entry.kind)).toEqual(['scoresaber', 'beatleader', 'url']);
});
