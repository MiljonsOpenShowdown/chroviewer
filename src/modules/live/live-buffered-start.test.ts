import { create } from '@bufbuild/protobuf';
import { describe, expect, test, vi } from 'vite-plus/test';

import { createClock } from '../../core/clock/song-clock';
import { sampleReplayFrames } from '../../core/replay/sampling';
import type { Replay, ReplayPose } from '../../core/replay/types';
import { ReplayChunkSchema, ReplayStreamStartSchema } from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import { tickLivePlayback } from './live-playback';
import { createLiveReplay } from './live-replay';
import { applyLiveReplayChunk } from './live-replay-stream';
import { createLiveRuntime, pruneLiveReplay, resetLiveStream } from './live-runtime';

vi.mock('lzma-web/dist/lzma.js', () => ({ LZMA: () => ({ decompress: vi.fn() }) }));

function fixture(source: 'ta' | 'scoresaber' = 'ta') {
  const runtime = createLiveRuntime({ source, playerId: 'player' });
  const replay = createLiveReplay(create(ReplayStreamStartSchema));
  runtime.replay = replay;
  let now = 0;
  const clock = createClock(300, 120, { now: () => now });
  const transform = { position: { x: 0, y: 1.7, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const pose = (time: number): ReplayPose => ({
    time,
    fps: 144,
    head: transform,
    leftHand: { ...transform, position: { ...transform.position, x: time } },
    rightHand: transform,
  });
  const actions = {
    pause: vi.fn(() => clock.pause()),
    resume: vi.fn(() => {
      clock.play();
      return clock.isPlaying();
    }),
    seek: vi.fn((time: number) => clock.seek(time)),
    updateStatus: vi.fn(),
  };
  return {
    runtime,
    replay,
    clock,
    pose,
    actions,
    advance: (seconds: number) => {
      now += seconds;
    },
    appendChunk: (start: number, seconds: number, fps = 90, rate = 1) => {
      const chunk = create(ReplayChunkSchema, {
        events: {
          poseFrames: Array.from({ length: Math.round(seconds * fps) }, (_, index) => {
            const time = start + (index / fps) * rate;
            const hand = { position: { x: time }, rotation: { w: 1 } };
            return { timeSeconds: time, fps, head: hand, left: hand, right: hand };
          }),
        },
      });
      applyLiveReplayChunk(
        runtime,
        chunk,
        () => {},
        () => {},
        () => {},
      );
    },
  };
}

function expectInterpolatedPose(replay: Replay, time: number) {
  const sample = sampleReplayFrames(replay.poses, time);
  if (sample === null) throw new Error('missing replay sample');
  expect(sample.from.time).toBeLessThanOrEqual(time);
  expect(sample.to.time).toBeGreaterThan(time);
  expect(sample.to.time - sample.from.time).toBeLessThan(0.03);
  const position =
    sample.from.leftHand.position.x + (sample.to.leftHand.position.x - sample.from.leftHand.position.x) * sample.amount;
  expect(position).toBeCloseTo(time, 6);
}

describe('buffered group playback', () => {
  test('eight waiting streams keep a minute of 144 Hz poses, then prune behind their delayed playhead', () => {
    for (let player = 0; player < 8; player++) {
      const { runtime, replay, clock, pose } = fixture();
      runtime.compositorBufferSeconds = 60;
      for (let second = 0; second <= 60; second++) {
        for (let frame = 0; frame < 144; frame++) replay.poses.push(pose(second + frame / 144));
        runtime.latestFrameTime = replay.poses.at(-1)?.time ?? 0;
        pruneLiveReplay(runtime, runtime.latestFrameTime);
      }
      expect(replay.poses[0]?.time).toBe(0);
      expect(replay.poses.length).toBeGreaterThan(8_000);
      runtime.playbackClock = clock;
      clock.seek(30);
      runtime.latestFrameTime = 90;
      pruneLiveReplay(runtime, 90);
      expect(replay.poses[0]?.time).toBeGreaterThanOrEqual(14.98);
      expect(replay.poses[0]?.time).toBeLessThan(15);
      expect(replay.poses.some((frame) => frame.time === 30)).toBe(true);
    }
  });

  test('a minute of accelerated 240 Hz playback remains buffered in song time', () => {
    const { runtime, replay, pose } = fixture();
    runtime.compositorBufferSeconds = 60;
    runtime.playbackRate = 1.5;
    replay.poses = Array.from({ length: 60 * 240 }, (_, index) => pose((index / 240) * 1.5));
    runtime.latestFrameTime = 90;
    pruneLiveReplay(runtime, 90);
    expect(replay.poses[0]?.time).toBe(0);
    expect(replay.poses.length).toBe(60 * 240);
  });

  test('non-TA waiting history is bounded and ordinary playback keeps the original pose cap', () => {
    const { runtime, replay, pose } = fixture('scoresaber');
    runtime.compositorBufferSeconds = 60;
    replay.poses = Array.from({ length: 30_000 }, (_, index) => pose(index / 144));
    runtime.latestFrameTime = 30_000 / 144;
    pruneLiveReplay(runtime, runtime.latestFrameTime);
    expect(replay.poses.length).toBeLessThanOrEqual(80 * 240);
    runtime.compositorBufferSeconds = 0;
    pruneLiveReplay(runtime, runtime.latestFrameTime);
    expect(replay.poses.length).toBeLessThanOrEqual(1800);
    resetLiveStream(runtime);
    expect(runtime.compositorBufferSeconds).toBe(0);
    expect(runtime.compositorStartAligned).toBe(false);
  });

  test.each([60, 90, 120, 144, 240])('TA timeout fallback retains unread %i Hz poses at each song speed', (fps) => {
    for (const rate of [0.75, 1, 1.5]) {
      const { runtime, replay, clock, actions, advance, appendChunk } = fixture();
      runtime.compositorBufferSeconds = 60;
      runtime.playbackRate = rate;
      for (let second = 0; second < 60; second++) appendChunk(second * rate, 1, fps, rate);
      expect(replay.poses[0]?.time).toBe(0);

      // The connection clears this field after a missing-player timeout. That
      // must not change which poses the TA consumer is allowed to retain.
      runtime.compositorBufferSeconds = 0;
      runtime.mapLoaded = true;
      tickLivePlayback(runtime, clock, 'Standard:9', actions);
      expect(actions.seek).toHaveBeenCalledExactlyOnceWith(0);
      expect(replay.poses[0]?.time).toBe(0);

      for (let frame = 0; frame < 10 * 60; frame++) {
        advance(1 / 60);
        if (frame % 60 === 0) appendChunk((60 + frame / 60) * rate, 1, fps, rate);
        tickLivePlayback(runtime, clock, 'Standard:9', actions);
        expectInterpolatedPose(replay, clock.currentTime());
      }
      expect(actions.seek).toHaveBeenCalledTimes(1);
      expect(actions.pause).not.toHaveBeenCalled();
    }
  });

  test('an ordinary TA view keeps late backlog delivered after playback has started', () => {
    const { runtime, replay, clock, actions, advance, appendChunk } = fixture();
    runtime.mapLoaded = true;
    appendChunk(50, 2);
    tickLivePlayback(runtime, clock, 'Standard:9', actions);
    expect(clock.currentTime()).toBe(50);
    advance(0.1);
    appendChunk(52, 58);
    tickLivePlayback(runtime, clock, 'Standard:9', actions);
    expectInterpolatedPose(replay, clock.currentTime());
    expect(actions.seek).toHaveBeenCalledTimes(1);

    // The same buffered data remains usable after the producer finishes.
    runtime.streamEnding = true;
    for (let frame = 0; frame < 30 * 60; frame++) {
      advance(1 / 60);
      tickLivePlayback(runtime, clock, 'Standard:9', actions);
      expectInterpolatedPose(replay, clock.currentTime());
    }
  });

  test.each([0, 30])(
    'TA keeps paused unread poses with a %i second compositor buffer and prunes consumed history',
    (wait) => {
      const { runtime, replay, clock, appendChunk } = fixture();
      runtime.compositorBufferSeconds = wait;
      appendChunk(0, 120, 240);
      expect(replay.poses).toHaveLength(120 * 240);
      runtime.playbackClock = clock;
      clock.seek(45);
      pruneLiveReplay(runtime, runtime.latestFrameTime);
      expect(replay.poses[0]?.time).toBeCloseTo(30 - 1 / 240, 5);
      expectInterpolatedPose(replay, 45.002);
      const retainedPose = replay.poses[0];
      const prune = vi.spyOn(replay.poses, 'splice');

      appendChunk(120, 60, 240);
      for (let packet = 0; packet < 100; packet++) pruneLiveReplay(runtime, 180 + packet);
      expect(replay.poses[0]).toBe(retainedPose);
      expect(prune).not.toHaveBeenCalled();
      expect(replay.poses.at(-1)?.time).toBeCloseTo(180 - 1 / 240, 5);

      clock.seek(179.5);
      pruneLiveReplay(runtime, 180);
      expectInterpolatedPose(replay, clock.currentTime());
      expect(replay.poses.length).toBeLessThan(16 * 240);
      expect(prune).toHaveBeenCalledTimes(1);

      resetLiveStream(runtime);
      expect(runtime.replay).toBeNull();
      expect(runtime.playbackClock).toBeNull();
      expect(runtime.lastPruneAt).toBe(0);
    },
  );

  test('TA event pruning does not move scores and note history ahead of delayed playback', () => {
    const { runtime, replay, clock, appendChunk } = fixture();
    appendChunk(0, 60);
    const note = create(ReplayChunkSchema, {
      events: {
        noteEvents: [{ timeSeconds: 20, eventType: 3 }],
        scoreEvents: [
          { timeSeconds: 5, score: 100 },
          { timeSeconds: 20, score: 200 },
          { timeSeconds: 45, score: 300 },
        ],
        comboEvents: [{ timeSeconds: 20, combo: 5 }],
        heightEvents: [{ timeSeconds: 20, height: 1.8 }],
      },
    });
    applyLiveReplayChunk(
      runtime,
      note,
      () => {},
      () => {},
      () => {},
    );
    runtime.playbackClock = clock;
    clock.seek(20);
    pruneLiveReplay(runtime, runtime.latestFrameTime);
    expect(replay.notes).toHaveLength(1);
    expect(replay.scores.map((event) => event.time)).toEqual([5, 20, 45]);
    expect(replay.combos[0]?.time).toBe(20);
    expect(replay.heights[0]?.time).toBe(20);
    expect(replay.liveHistoryBase?.misses ?? 0).toBe(0);

    clock.seek(40);
    pruneLiveReplay(runtime, runtime.latestFrameTime);
    expect(replay.notes).toHaveLength(0);
    expect(replay.scores.map((event) => event.time)).toEqual([20, 45]);
    expect(replay.liveHistoryBase?.misses).toBe(1);
  });

  test.each(['ta', 'scoresaber'] as const)(
    '%s preserves a coordinated start despite being 30 seconds behind the live edge',
    (source) => {
      const { runtime, replay, clock, pose } = fixture(source);
      replay.poses = [pose(0), pose(30)];
      runtime.latestFrameTime = 30;
      runtime.mapLoaded = true;
      runtime.playbackStarted = true;
      runtime.compositorStartAligned = true;
      runtime.compositorBufferSeconds = 30;
      runtime.playbackClock = clock;
      clock.play();
      const actions = { pause: vi.fn(), resume: vi.fn(() => true), seek: vi.fn(), updateStatus: vi.fn() };
      for (let tick = 0; tick < 300; tick++) {
        runtime.playbackAttemptPending = true;
        tickLivePlayback(runtime, clock, 'Standard:9', actions);
      }
      expect(actions.seek).not.toHaveBeenCalled();
      expect(actions.pause).not.toHaveBeenCalled();
      expect(clock.currentTime()).toBe(0);
    },
  );

  test('ordinary ScoreSaber playback still recovers excessive live delay', () => {
    const { runtime, replay, clock, pose } = fixture('scoresaber');
    replay.poses = [pose(0), pose(30)];
    runtime.latestFrameTime = 30;
    runtime.mapLoaded = true;
    runtime.playbackStarted = true;
    runtime.playbackAttemptPending = true;
    clock.play();
    const actions = { pause: vi.fn(), resume: vi.fn(() => true), seek: vi.fn(), updateStatus: vi.fn() };
    tickLivePlayback(runtime, clock, 'Standard:9', actions);
    expect(actions.seek).toHaveBeenCalledWith(29);
  });
});
