import type { EffectCallback } from 'react';

import { create, toBinary } from '@bufbuild/protobuf';
import { Result } from 'better-result';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { createClock } from '../../core/clock/song-clock';
import { sampleReplayFrames } from '../../core/replay/sampling';
import { MultiviewStartBarrier } from '../multiview/multiview-start-barrier';
import {
  ReplayChunkSchema,
  ReplayCompletion,
  ReplayStreamEndSchema,
  ReplayStreamPacketSchema,
  ReplayStreamStartSchema,
  type ReplayStreamPacket,
} from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import type { LiveRuntime } from './live-runtime';
import { initialLiveState } from './live-state';
import type { LiveExperienceOptions } from './live-types';
import { useLiveConnection } from './use-live-connection';

const { useEffectMock } = vi.hoisted(() => ({ useEffectMock: vi.fn() }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: useEffectMock,
}));
vi.mock('lzma-web/dist/lzma.js', () => ({ LZMA: () => ({ decompress: vi.fn() }) }));

const cleanups: (() => void)[] = [];
const barriers: MultiviewStartBarrier[] = [];

class ReplaySocket {
  static OPEN = 1;
  static instances: ReplaySocket[] = [];
  readyState = ReplaySocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    ReplaySocket.instances.push(this);
  }

  receive(packet: ReplayStreamPacket) {
    const bytes = toBinary(ReplayStreamPacketSchema, packet);
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  vi.stubGlobal('WebSocket', ReplaySocket);
  ReplaySocket.instances = [];
  useEffectMock.mockImplementation((effect: EffectCallback) => {
    const cleanup = effect();
    if (cleanup !== undefined) cleanups.push(cleanup);
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const barrier of barriers.splice(0)) barrier.dispose();
  useEffectMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function compositor(playerCount: number, waitForAll: boolean) {
  const barrier = new MultiviewStartBarrier();
  barriers.push(barrier);
  barrier.configure(
    Array.from({ length: playerCount }, (_, index) => ({
      id: String(index),
      playerId: String(index),
      visible: true,
      settings: { compositorSyncType: waitForAll ? 'wait-for-all' : 'slow', compositorWaitSeconds: 30 },
    })),
  );
  return barrier;
}

async function connectPlayer(id: string, barrier: MultiviewStartBarrier) {
  const target = { source: 'ta' as const, playerId: id };
  const clock = createClock(180, 120, { now: () => performance.now() / 1000 });
  const runtimeRef = { current: null as LiveRuntime | null };
  let state = initialLiveState;
  const optionsRef = {
    current: {
      target,
      externalTimeline: true,
      startBarrier: { id, barrier },
      selectedKey: 'Standard:9',
      hasLiveMap: () => true,
      loadLiveReplay: async () => Result.ok(undefined),
      appendReplayNoteEvents: vi.fn(),
      appendReplayHeightEvents: vi.fn(),
      refreshReplayDisplay: vi.fn(),
      transport: {
        clockRef: { current: clock },
        seek: vi.fn((time: number) => clock.seek(time)),
        togglePlay: () => {
          if (clock.isPlaying()) clock.pause();
          else clock.play();
          return clock.isPlaying();
        },
        play: () => {
          clock.play();
          return clock.isPlaying();
        },
      },
    } satisfies LiveExperienceOptions,
  };
  useLiveConnection(target, optionsRef, runtimeRef, (update) => {
    state = typeof update === 'function' ? update(state) : update;
  });
  const socket = ReplaySocket.instances.at(-1);
  if (socket === undefined) throw new Error('missing replay socket');
  const receive = (body: ReplayStreamPacket['body']) => {
    socket.receive(create(ReplayStreamPacketSchema, { streamId: `stream:${id}`, playerId: id, body }));
  };
  receive({
    case: 'start',
    value: create(ReplayStreamStartSchema, {
      beatmap: { mapHash: 'A'.repeat(40), difficulty: 9, characteristic: 'Standard' },
      replayMetadata: { songSpeed: 1 },
    }),
  });
  await Promise.resolve();
  let sequence = 0n;
  return {
    clock,
    runtimeRef,
    transport: optionsRef.current.transport,
    get status() {
      return state.status;
    },
    chunk(start: number, seconds: number, fps = 144) {
      receive({
        case: 'chunk',
        value: create(ReplayChunkSchema, {
          cursor: { sequence: ++sequence, songTimeMs: BigInt((start + seconds) * 1000) },
          events: {
            poseFrames: Array.from({ length: seconds * fps }, (_, index) => {
              const time = start + index / fps;
              const hand = { position: { x: time }, rotation: { w: 1 } };
              return { timeSeconds: time, fps, head: hand, left: hand, right: hand };
            }),
          },
        }),
      });
    },
    end(time: number) {
      receive({
        case: 'end',
        value: create(ReplayStreamEndSchema, {
          cursor: { sequence: ++sequence, songTimeMs: BigInt(time * 1000) },
          completion: ReplayCompletion.PASSED,
        }),
      });
    },
  };
}

function expectMovingPose(player: Awaited<ReturnType<typeof connectPlayer>>) {
  const replay = player.runtimeRef.current?.replay;
  if (replay === undefined || replay === null) throw new Error('missing live replay');
  const time = player.clock.currentTime();
  const sample = sampleReplayFrames(replay.poses, time);
  if (sample === null) throw new Error('missing live pose sample');
  expect(sample.from.time).toBeLessThanOrEqual(time);
  expect(sample.to.time).toBeGreaterThan(time);
  expect(sample.to.time - sample.from.time).toBeLessThan(0.02);
  expect(
    sample.from.leftHand.position.x + (sample.to.leftHand.position.x - sample.from.leftHand.position.x) * sample.amount,
  ).toBeCloseTo(time, 6);
}

describe('TA compositor pose retention through the connection', () => {
  test('four of six players keep moving during reception and buffered playback after the real timeout', async () => {
    const barrier = compositor(6, true);
    const players = await Promise.all(Array.from({ length: 4 }, (_, index) => connectPlayer(String(index), barrier)));
    for (const player of players) player.chunk(0, 30);
    expect(players.every((player) => !player.clock.isPlaying())).toBe(true);

    await vi.advanceTimersByTimeAsync(30_100);
    for (const player of players) {
      expect(player.status).toBe('watching');
      expect(player.runtimeRef.current?.compositorBufferSeconds).toBe(0);
      expect(player.runtimeRef.current?.compositorStartAligned).toBe(false);
      expect(player.transport.seek).toHaveBeenCalledExactlyOnceWith(0);
      expect(player.runtimeRef.current?.replay?.poses[0]?.time).toBe(0);
    }

    for (let second = 30; second < 40; second++) {
      for (const player of players) player.chunk(second, 1);
      for (let frame = 0; frame < 60; frame++) {
        vi.advanceTimersByTime(1000 / 60);
        for (const player of players) expectMovingPose(player);
      }
    }
    for (const player of players) player.end(40);
    for (let frame = 0; frame < 10 * 60; frame++) {
      vi.advanceTimersByTime(1000 / 60);
      for (const player of players) expectMovingPose(player);
    }
    for (const player of players) expect(player.transport.seek).toHaveBeenCalledTimes(1);
  });

  test('all connected players keep moving when a late backlog arrives after ordinary startup', async () => {
    const barrier = compositor(4, false);
    const players = await Promise.all(Array.from({ length: 4 }, (_, index) => connectPlayer(String(index), barrier)));
    for (const player of players) player.chunk(50, 2);
    await vi.advanceTimersByTimeAsync(100);
    for (const player of players) player.chunk(52, 58);
    for (let frame = 0; frame < 10 * 60; frame++) {
      vi.advanceTimersByTime(1000 / 60);
      for (const player of players) expectMovingPose(player);
    }
    for (const player of players) {
      expect(player.status).toBe('watching');
      expect(player.transport.seek).toHaveBeenCalledExactlyOnceWith(50);
    }
  });
});
