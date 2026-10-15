import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test, vi } from 'vite-plus/test';

import { ReplayCompletion, ReplayStreamPacketSchema } from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import { isTaReplayFile, parseTaReplayFile, TA_REPLAY_FILE_HEADER } from './ta-replay-file';

// live-replay imports the ScoreSaber parser, whose LZMA worker is browser-only.
vi.mock('lzma-web/dist/lzma.js', () => ({ LZMA: () => ({ decompress: vi.fn() }) }));

type PacketInit = Parameters<typeof create<typeof ReplayStreamPacketSchema>>[1];

function encodeFile(packets: PacketInit[]) {
  const frames = packets.map((packet) => toBinary(ReplayStreamPacketSchema, create(ReplayStreamPacketSchema, packet)));
  const size = TA_REPLAY_FILE_HEADER.byteLength + frames.reduce((total, frame) => total + 4 + frame.byteLength, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(TA_REPLAY_FILE_HEADER, 0);
  let offset = TA_REPLAY_FILE_HEADER.byteLength;
  for (const frame of frames) {
    view.setUint32(offset, frame.byteLength, true);
    bytes.set(frame, offset + 4);
    offset += 4 + frame.byteLength;
  }
  return bytes;
}

const start: PacketInit = {
  streamId: 'play-1',
  body: {
    case: 'start',
    value: {
      protocolVersion: 1,
      beatmap: { mapHash: 'abcdef0123456789abcdef0123456789abcdef01', characteristic: 'Standard', difficulty: 9 },
      replayMetadata: { jumpDistance: 18, songSpeed: 1 },
    },
  },
};

function chunk(sequence: bigint, time: number, streamId = 'play-1'): PacketInit {
  return {
    streamId,
    body: {
      case: 'chunk',
      value: {
        cursor: { sequence },
        events: {
          poseFrames: [{ timeSeconds: time, fps: 90, head: {}, left: {}, right: {} }],
          scoreEvents: [{ score: Number(sequence) * 100, timeSeconds: time }],
          minTimeSeconds: time,
          maxTimeSeconds: time,
        },
      },
    },
  };
}

describe('recorded TA replay files', () => {
  test('rebuilds a replay from start, chunks and end', () => {
    const replay = parseTaReplayFile(
      encodeFile([
        start,
        chunk(1n, 0.5),
        chunk(2n, 1),
        {
          streamId: 'play-1',
          body: {
            case: 'end',
            value: {
              cursor: { songTimeMs: 1200n },
              completion: ReplayCompletion.FAILED,
              score: { score: 250, modifiedScore: 240, maxScore: 300, combo: 7 },
            },
          },
        },
      ]),
    );
    expect(replay.metadata.levelId).toBe('custom_level_ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    expect(replay.metadata.jumpDistance).toBe(18);
    expect(replay.poses.map((pose) => pose.time)).toEqual([0.5, 1]);
    expect(replay.metadata.failTime).toBe(1.2);
    expect(replay.scores.at(-1)).toEqual({ score: 240, time: 1.2, immediateMaxPossibleScore: 300 });
    expect(replay.combos.at(-1)).toEqual({ combo: 7, time: 1.2 });
  });

  test('restores send order and ignores frames from other streams', () => {
    const replay = parseTaReplayFile(encodeFile([start, chunk(2n, 1), chunk(9n, 5, 'other-play'), chunk(1n, 0.5)]));
    expect(replay.poses.map((pose) => pose.time)).toEqual([0.5, 1]);
    expect(replay.scores.map((score) => score.score)).toEqual([100, 200]);
  });

  test('rejects files that are not recordings or are cut off', () => {
    expect(isTaReplayFile(new Uint8Array([1, 2, 3]))).toBe(false);
    const bytes = encodeFile([start, chunk(1n, 0.5)]);
    expect(isTaReplayFile(bytes)).toBe(true);
    expect(() => parseTaReplayFile(bytes.subarray(0, bytes.byteLength - 3))).toThrow('truncated');
    expect(() => parseTaReplayFile(encodeFile([chunk(1n, 0.5)]))).toThrow('no start packet');
  });
});
