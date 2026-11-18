import { describe, expect, test } from 'vite-plus/test';

import { parseAudioFxMessage } from './overlay-audio-fx';

const valid = { type: 'beatkhana:audio-fx', version: 1, volume: 0.35, lowpassHz: 900, rampMs: 1500 };

describe('audio-fx message', () => {
  test('accepts a valid message, with or without a cutoff', () => {
    expect(parseAudioFxMessage(valid)).toEqual(valid);
    expect(parseAudioFxMessage({ ...valid, lowpassHz: null, volume: 1, rampMs: 0 })).toEqual({
      ...valid,
      lowpassHz: null,
      volume: 1,
      rampMs: 0,
    });
  });

  test('ignores anything else', () => {
    for (const message of [
      null,
      'beatkhana:audio-fx',
      { ...valid, type: 'beatkhana:multiview-control' },
      { ...valid, version: 2 },
      { ...valid, volume: 1.5 },
      { ...valid, volume: -0.1 },
      { ...valid, volume: Number.NaN },
      { ...valid, lowpassHz: 5 },
      { ...valid, lowpassHz: undefined },
      { ...valid, rampMs: -1 },
      { ...valid, rampMs: Number.POSITIVE_INFINITY },
      { type: 'beatkhana:audio-fx', version: 1, volume: 0.5 },
    ])
      expect(parseAudioFxMessage(message)).toBeNull();
  });
});
