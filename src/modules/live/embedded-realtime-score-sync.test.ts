import { describe, expect, test } from 'vite-plus/test';

import { EmbeddedRealtimeScoreTimeline, isEmbeddedRealtimeScoreMessage } from './embedded-realtime-score-sync';

describe('embedded realtime score sync', () => {
  test('matches the iframe player using any supplied platform identifier', () => {
    expect(
      isEmbeddedRealtimeScoreMessage(
        {
          type: 'beatkhana:realtime-score',
          version: 1,
          playerId: 'ta-player',
          platformIds: ['76561198000000000', 'BL-PLAYER'],
          score: { songPosition: 12, score: 1234 },
          sentAt: Date.now(),
        },
        'bl-player',
      ),
    ).toBe(true);
  });

  test('returns the score aligned to replay time and resets for a new song', () => {
    const timeline = new EmbeddedRealtimeScoreTimeline();
    timeline.add({ songPosition: 5, score: 100, notesMissed: 0 });
    timeline.add({ songPosition: 7, score: 200, notesMissed: 1 });
    expect(timeline.at(6)?.score.score).toBe(100);
    expect(timeline.at(7)?.score.notesMissed).toBe(1);

    timeline.add({ songPosition: 0.25, score: 10, notesMissed: 0 });
    expect(timeline.size).toBe(1);
    expect(timeline.at(1)?.score.score).toBe(10);
  });
});
