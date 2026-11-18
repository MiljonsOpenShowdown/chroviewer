import { describe, expect, test } from 'vite-plus/test';

import { parsePreviewControlMessage } from './overlay-preview-control';

const base = { type: 'beatkhana:multiview-control', version: 1 };

describe('AI preview control message', () => {
  test('accepts play, pause and seek; a seek tileId is dropped', () => {
    expect(parsePreviewControlMessage({ ...base, action: 'play' })).toEqual({ ...base, action: 'play' });
    expect(parsePreviewControlMessage({ ...base, action: 'pause' })).toEqual({ ...base, action: 'pause' });
    expect(parsePreviewControlMessage({ ...base, action: 'seek', time: 12.5, tileId: 'p1' })).toEqual({
      ...base,
      action: 'seek',
      time: 12.5,
    });
  });

  test('ignores other actions and invalid messages', () => {
    for (const message of [
      { ...base, action: 'rate', rate: 2 },
      { ...base, action: 'sync', anchorId: 'p1' },
      { ...base, action: 'seek' },
      { ...base, action: 'seek', time: -1 },
      { ...base, action: 'seek', time: Number.NaN },
      { ...base, version: 2, action: 'play' },
      { type: 'beatkhana:audio-fx', version: 1, action: 'play' },
      null,
    ])
      expect(parsePreviewControlMessage(message)).toBeNull();
  });
});
