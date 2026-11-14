import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test, vi } from 'vite-plus/test';

import {
  ReplayCompletion,
  ReplayPlatform,
  ReplayStreamPacketSchema,
} from './generated/proto/scoresaber/live/v1/replay_stream_pb';
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

type PoseInit = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};
type PoseFrameInit = { timeSeconds: number; fps: number; head: PoseInit; left: PoseInit; right: PoseInit };

function varint(value: number) {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

// Independent writer of the v2 layout: framed packets with emptied poseFrames, then the varint pose block.
function encodeFileV2(packets: PacketInit[], framesPerPacket: PoseFrameInit[][]) {
  const emptied = packets.map((packet) => {
    const copy = create(ReplayStreamPacketSchema, packet);
    if (copy.body.case === 'chunk' && copy.body.value.events) copy.body.value.events.poseFrames = [];
    return toBinary(ReplayStreamPacketSchema, copy);
  });
  const section = new Uint8Array(emptied.reduce((total, frame) => total + 4 + frame.byteLength, 0));
  const sectionView = new DataView(section.buffer);
  let offset = 0;
  for (const frame of emptied) {
    sectionView.setUint32(offset, frame.byteLength, true);
    section.set(frame, offset + 4);
    offset += 4 + frame.byteLength;
  }

  const frames = framesPerPacket.flat();
  const bits = new DataView(new ArrayBuffer(4));
  const columns: number[][] = [
    frames.map((frame) => {
      bits.setFloat32(0, frame.timeSeconds);
      return bits.getUint32(0);
    }),
    frames.map((frame) => frame.fps),
  ];
  for (const hand of ['head', 'left', 'right'] as const) {
    for (const key of ['x', 'y', 'z'] as const) {
      columns.push(frames.map((frame) => Math.round(frame[hand].position[key] * 10000)));
    }
    for (const key of ['x', 'y', 'z', 'w'] as const) {
      columns.push(frames.map((frame) => Math.round(frame[hand].rotation[key] * 32767)));
    }
  }
  const block = framesPerPacket.map((list) => list.length).flatMap(varint);
  for (const column of columns) {
    let previous = 0;
    for (const value of column) {
      const delta = value - previous;
      block.push(...varint(delta >= 0 ? 2 * delta : -2 * delta - 1));
      previous = value;
    }
  }

  const header = new TextEncoder().encode('TAReplayStream v2\n');
  const bytes = new Uint8Array(header.byteLength + 4 + section.byteLength + block.length);
  bytes.set(header, 0);
  new DataView(bytes.buffer).setUint32(header.byteLength, section.byteLength, true);
  bytes.set(section, header.byteLength + 4);
  bytes.set(block, header.byteLength + 4 + section.byteLength);
  return bytes;
}

function poseFrame(time: number, fps: number, seed: number): PoseFrameInit {
  const pose = (shift: number): PoseInit => ({
    position: { x: -1.2345 + seed * shift, y: 1.6789 - seed * 0.37, z: -300.1234 + seed * 1.9 },
    rotation: { x: 0.1 * shift - seed * 0.01, y: -0.5, z: 0.25 + seed * 0.003, w: 0.8 },
  });
  return { timeSeconds: time, fps, head: pose(1), left: pose(-2), right: pose(3.5) };
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

  test('names the player of the play', () => {
    const startOf = (player?: { playerId: string; platform: ReplayPlatform }): PacketInit => ({
      streamId: 'play-1',
      body: { case: 'start', value: { protocolVersion: 1, player } },
    });
    const player = (packet: PacketInit) => parseTaReplayFile(encodeFile([packet])).metadata.player;
    expect(player(startOf({ playerId: '76561198000000001', platform: ReplayPlatform.STEAM }))).toEqual({
      id: '76561198000000001',
      name: '76561198000000001',
    });
    // MOS' AI plays under a made-up ID: its BeatLeader profile is shown instead
    expect(player(startOf({ playerId: 'ai-1', platform: ReplayPlatform.DEV }))).toEqual({
      id: '360351',
      name: 'MOSes',
      profile: 'beatleader',
    });
    expect(player(startOf())).toBeUndefined();
  });

  test('rejects files that are not recordings or are cut off', () => {
    expect(isTaReplayFile(new Uint8Array([1, 2, 3]))).toBe(false);
    const bytes = encodeFile([start, chunk(1n, 0.5)]);
    expect(isTaReplayFile(bytes)).toBe(true);
    expect(() => parseTaReplayFile(bytes.subarray(0, bytes.byteLength - 3))).toThrow('truncated');
    expect(() => parseTaReplayFile(encodeFile([chunk(1n, 0.5)]))).toThrow('no start packet');
  });
});

describe('recorded TA replay files (v2)', () => {
  const firstFrames = [poseFrame(0.1, 90, 1), poseFrame(0.2, 72, 2), poseFrame(1234.5678, 90, 3)];
  const secondFrames = [poseFrame(1234.6, 60, 0), poseFrame(2000.25, 144, 40)];

  function v2Chunk(sequence: bigint, frames: PoseFrameInit[]): PacketInit {
    const time = frames[0]?.timeSeconds ?? 0;
    return {
      streamId: 'play-1',
      body: {
        case: 'chunk',
        value: {
          cursor: { sequence },
          events: { poseFrames: frames, scoreEvents: [{ score: Number(sequence) * 100, timeSeconds: time }] },
        },
      },
    };
  }

  const packets = [
    start,
    v2Chunk(1n, firstFrames),
    { streamId: 'play-1', body: { case: 'chunk' as const, value: { cursor: { sequence: 2n } } } },
    v2Chunk(3n, secondFrames),
    { streamId: 'play-1', body: { case: 'end' as const, value: { cursor: { songTimeMs: 2100n } } } },
  ];
  const bytes = () => encodeFileV2(packets, [[], firstFrames, [], secondFrames, []]);

  test('restores quantized poses in order and keeps the other events', () => {
    const replay = parseTaReplayFile(bytes());
    const frames = [...firstFrames, ...secondFrames];
    expect(replay.poses).toHaveLength(frames.length);
    replay.poses.forEach((pose, index) => {
      const expected = frames[index];
      if (expected === undefined) throw new Error('unexpected extra pose');
      expect(pose.time).toBe(Math.fround(expected.timeSeconds));
      for (const [hand, field] of [
        ['head', 'head'],
        ['left', 'leftHand'],
        ['right', 'rightHand'],
      ] as const) {
        const actual = pose[field];
        for (const key of ['x', 'y', 'z'] as const) {
          expect(Math.abs(actual.position[key] - expected[hand].position[key])).toBeLessThanOrEqual(0.00005);
        }
        for (const key of ['x', 'y', 'z', 'w'] as const) {
          expect(Math.abs(actual.rotation[key] - expected[hand].rotation[key])).toBeLessThanOrEqual(1 / 65534);
        }
      }
    });
    expect(replay.scores.map((score) => score.score)).toEqual([100, 300]);
  });

  test('is recognised as a recording', () => {
    expect(isTaReplayFile(bytes())).toBe(true);
  });

  test('rejects a v2 file cut off inside the pose block', () => {
    const full = bytes();
    expect(() => parseTaReplayFile(full.subarray(0, full.byteLength - 5))).toThrow('truncated');
  });

  test('decodes a fixture written by the recording side encoder', () => {
    const fixture =
      'VEFSZXBsYXlTdHJlYW0gdjIKqwAAAFIAAAAKBnBsYXktMVJICAEaNgooYWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMRgJKghTdGFuZGFyZGoMhQEAAIA/jQEAAJBBGwAAAAoGcGxheS0xWhEKAggBEgsiCQhkFQAAAD8YaR0AAAAKBnBsYXktMVoTCgIIAhINIgsI1wEVy6EFPxjcAREAAAAKBnBsYXktMWoHCgMQ2AQQAQACAQCAgIDwB8rDFszDFrQBACOkE6QTpBP46wHIAcgBhyeHJ4cngIACAAD9/wEAAJozmDOaM7LmAgAAoxOjE6MT6OgBxwHHAYgniCeIJ4CAAgAA/f8BAACZM5czmTOy5gIAAMgmyCbIJsDtAZADkAOPTo9Oj06AgAIAAP3/AQAAsma0ZrJmsuYCAAA=';
    const replay = parseTaReplayFile(Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0)));
    const expectedFrames = [
      { time: 0.5, fps: 90, scale: 1 },
      { time: 0.511, fps: 90, scale: 2 },
      { time: 0.522, fps: 72, scale: 3 },
    ];
    expect(replay.poses).toHaveLength(expectedFrames.length);
    replay.poses.forEach((pose, index) => {
      const expected = expectedFrames[index];
      if (expected === undefined) throw new Error('unexpected extra pose');
      expect(pose.time).toBe(Math.fround(expected.time));
      expect(pose.fps).toBe(expected.fps);
      for (const [field, factor] of [
        ['head', 1],
        ['leftHand', -1],
        ['rightHand', 2],
      ] as const) {
        const k = expected.scale * factor;
        const { position, rotation } = pose[field];
        const wantPosition = { x: 0.1234 * k, y: 1.5 + 0.01 * k, z: -0.25 * k };
        const wantRotation = { x: 0.5, y: -0.5, z: 0.1 * k, w: 0.7 };
        for (const key of ['x', 'y', 'z'] as const) {
          expect(Math.abs(position[key] - wantPosition[key])).toBeLessThanOrEqual(0.00005);
        }
        for (const key of ['x', 'y', 'z', 'w'] as const) {
          expect(Math.abs(rotation[key] - wantRotation[key])).toBeLessThanOrEqual(1 / 65534);
        }
      }
    });
    expect(replay.scores.map((score) => score.score)).toEqual(expect.arrayContaining([100, 215]));
  });
});
