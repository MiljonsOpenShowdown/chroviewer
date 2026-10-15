import { create } from '@bufbuild/protobuf';
import { describe, expect, test, vi } from 'vite-plus/test';

import { ReplayExtensionSchema, ReplayStreamStartSchema } from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import { applyLiveReplayExtensions, createLiveReplay } from './live-replay';

// These tests exercise the real extension parser, without creating the browser
// LZMA worker used to decompress complete ScoreSaber replay files.
vi.mock('lzma-web/dist/lzma.js', () => ({ LZMA: () => ({ decompress: vi.fn() }) }));

const extension = (payload: number[]) =>
  create(ReplayExtensionSchema, {
    id: 'scoresaber.hsv-config',
    version: 1,
    payload: new Uint8Array(payload),
  });

describe('per-player live cosmetics', () => {
  test('repeated HSV packets retain the same config; new configs still apply', () => {
    const replay = createLiveReplay(create(ReplayStreamStartSchema));
    applyLiveReplayExtensions(replay, [extension([1, 2, 3])], true);
    const original = replay.hsvConfig;
    for (let packet = 0; packet < 100; packet++) {
      applyLiveReplayExtensions(replay, [extension([1, 2, 3])], true);
      expect(replay.hsvConfig).toBe(original);
    }
    applyLiveReplayExtensions(replay, [extension([1, 4, 3])], true);
    expect(replay.hsvConfig).not.toBe(original);
    expect(replay.hsvConfig).toEqual(new Uint8Array([1, 4, 3]));
  });

  test('eight players keep their own colors and HSV data', () => {
    const players = Array.from({ length: 8 }, (_, index) =>
      createLiveReplay(
        create(ReplayStreamStartSchema, {
          replayMetadata: { leftSaberColor: { r: index / 8, g: 0, b: 0, a: 1 } },
          replayExtensions: [extension([index, 2, 3])],
        }),
      ),
    );
    players.forEach((replay, index) => {
      expect(replay.metadata.leftSaberColor?.x).toBe(index / 8);
      expect(replay.hsvConfig).toEqual(new Uint8Array([index, 2, 3]));
    });
    const secondConfig = players[1]?.hsvConfig;
    const first = players[0];
    if (first === undefined) throw new Error('missing player');
    applyLiveReplayExtensions(first, [extension([7, 2, 3])], true);
    expect(players[1]?.hsvConfig).toBe(secondConfig);
  });
});
