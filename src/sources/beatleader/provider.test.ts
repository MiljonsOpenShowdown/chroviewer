import { describe, expect, test } from 'vite-plus/test';

import { fetchTopBeatLeaderScore } from './provider';

describe('fetchTopBeatLeaderScore', () => {
  test('requests rank ascending and selects the lowest returned rank defensively', async () => {
    let requestedUrl = '';
    const result = await fetchTopBeatLeaderScore('leaderboard-id', {
      request: (input) => {
        requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          Response.json({
            scores: [
              { id: 30, rank: 3 },
              { id: 10, rank: 1 },
              { id: 20, rank: 2 },
            ],
          }),
        );
      },
    });

    expect(requestedUrl).toContain('sortBy=rank&order=asc');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe('10');
  });
});
