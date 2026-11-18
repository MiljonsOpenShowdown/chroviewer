import { Matrix4, Quaternion } from 'three';
import { expect, test } from 'vite-plus/test';

import { mirrorLeftHandedReplay } from './mirror-replay';
import type { Replay, ReplayNoteEvent, ReplayQuaternion, ReplayTransform } from './types';

function transform(seed: number): ReplayTransform {
  const rotation = new Quaternion(0.1 * seed, 0.2, -0.3 * seed, 0.9).normalize();
  return {
    position: { x: 0.25 * seed, y: 1 + seed, z: -0.5 },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
  };
}

function noteEvent(overrides: Partial<ReplayNoteEvent> = {}): ReplayNoteEvent {
  return {
    noteId: { time: 2, lineLayer: 1, lineIndex: 0, colorType: 0, cutDirection: 2, cutDirectionAngleOffset: 15 },
    eventType: 1,
    cutPoint: { x: 0.4, y: 1.2, z: 0.1 },
    cutNormal: { x: 0.6, y: 0.2, z: 0.1 },
    saberDirection: { x: -0.3, y: 0.5, z: 0.7 },
    saberType: 0,
    directionOk: true,
    saberSpeed: 4,
    cutAngle: 12,
    cutDistanceToCenter: 0.05,
    cutDirectionDeviation: 3,
    beforeCutRating: 1,
    afterCutRating: 1,
    time: 2.01,
    unityTimescale: 1,
    timeSyncTimescale: 1,
    noteRotation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
    notePosition: { x: -0.45, y: 1, z: 0 },
    ...overrides,
  };
}

function replay(leftHanded: boolean): Replay {
  return {
    metadata: {
      version: '1',
      levelId: 'custom_level_ABCDEF',
      difficulty: 4,
      characteristic: 'Standard',
      environment: 'DefaultEnvironment',
      modifiers: [],
      noteSpawnOffset: 0,
      leftHanded,
      initialHeight: 1.8,
      roomRotation: 10,
      roomCenter: { x: 0.5, y: 0, z: 1 },
      failTime: 0,
      hasPlaySettings: true,
      leftSaberColor: { x: 1, y: 0, z: 0, a: 1 },
      rightSaberColor: { x: 0, y: 0, z: 1, a: 1 },
      controllerOffsets: {
        left: { position: { x: 0.1, y: 0, z: 0 }, rotation: { x: 10, y: 20, z: 30 } },
        right: { position: { x: -0.2, y: 0, z: 0 }, rotation: { x: 1, y: 2, z: 3 } },
      },
    },
    poses: [
      { time: 0, fps: 90, head: transform(1), leftHand: transform(2), rightHand: transform(3) },
      { time: 1, fps: 90, head: transform(4), leftHand: transform(5), rightHand: transform(6) },
    ],
    heights: [{ time: 0, height: 1.8 }],
    notes: [noteEvent(), noteEvent({ noteId: { time: 3, lineLayer: 0, lineIndex: 3, colorType: 1, cutDirection: 8 } })],
    scores: [],
    combos: [],
    multipliers: [],
    energies: [],
    pauses: [],
    walls: [
      {
        time: 4,
        exitTime: 4.5,
        energy: 0.9,
        obstacleTime: 3.8,
        obstacleDuration: 1,
        lineIndex: 0,
        lineLayer: 0,
        width: 1,
        height: 5,
      },
    ],
  };
}

function expectCloseTransform(actual: ReplayTransform, expected: ReplayTransform) {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(actual.position[axis]).toBeCloseTo(expected.position[axis], 6);
  }
  for (const axis of ['x', 'y', 'z', 'w'] as const) {
    expect(actual.rotation[axis]).toBeCloseTo(expected.rotation[axis], 6);
  }
}

function rotationMatrix(rotation: ReplayQuaternion) {
  return new Matrix4().makeRotationFromQuaternion(new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w));
}

test('returns a replay that is not left-handed untouched', () => {
  const source = replay(false);
  expect(mirrorLeftHandedReplay(source)).toBe(source);
});

test('does not mutate the input and clears the left-handed flag', () => {
  const source = replay(true);
  const snapshot = structuredClone(source);
  const mirrored = mirrorLeftHandedReplay(source);
  expect(source).toEqual(snapshot);
  expect(mirrored.metadata.leftHanded).toBe(false);
});

test('swaps hands, flips X and mirrors rotations as a reflection', () => {
  const source = replay(true);
  const mirrored = mirrorLeftHandedReplay(source);
  const pose = source.poses[0];
  const result = mirrored.poses[0];
  if (pose === undefined || result === undefined) throw new Error('missing pose');

  expect(result.leftHand.position).toEqual({ ...pose.rightHand.position, x: -pose.rightHand.position.x });
  expect(result.rightHand.position.x).toBe(-pose.leftHand.position.x);
  expect(result.head.position.x).toBe(-pose.head.position.x);

  // The mirrored rotation R' must equal M R M for the reflection M = diag(-1, 1, 1).
  const reflect = new Matrix4().makeScale(-1, 1, 1);
  const expected = reflect.clone().multiply(rotationMatrix(pose.head.rotation)).multiply(reflect);
  const actual = rotationMatrix(result.head.rotation);
  for (const [index, value] of expected.elements.entries()) expect(actual.elements[index]).toBeCloseTo(value, 6);
});

test('mirrors note events, walls and metadata', () => {
  const source = replay(true);
  const mirrored = mirrorLeftHandedReplay(source);
  const first = mirrored.notes[0];
  const second = mirrored.notes[1];
  if (first === undefined || second === undefined) throw new Error('missing note');

  expect(first.noteId).toMatchObject({ lineIndex: 3, colorType: 1, cutDirection: 3, cutDirectionAngleOffset: -15 });
  expect(first.noteId.time).toBe(2);
  expect(first.saberType).toBe(1);
  expect(first.cutPoint).toEqual({ x: -0.4, y: 1.2, z: 0.1 });
  expect(first.cutNormal.x).toBe(-0.6);
  expect(first.saberDirection.x).toBe(0.3);
  expect(first.notePosition?.x).toBe(0.45);
  expect(first.noteRotation).toEqual({ x: 0.1, y: -0.2, z: -0.3, w: 0.9 });
  expect(first.time).toBe(2.01);
  expect(second.noteId).toMatchObject({ lineIndex: 0, colorType: 0, cutDirection: 8 });
  expect(mirrored.walls[0]?.lineIndex).toBe(3);
  expect(mirrored.metadata.leftSaberColor).toEqual(source.metadata.rightSaberColor);
  expect(mirrored.metadata.rightSaberColor).toEqual(source.metadata.leftSaberColor);
  expect(mirrored.metadata.controllerOffsets?.left).toEqual({
    position: { x: 0.2, y: 0, z: 0 },
    rotation: { x: 1, y: -2, z: -3 },
  });
  expect(mirrored.metadata.roomRotation).toBe(-10);
});

test('mirroring twice restores the original replay', () => {
  const source = replay(true);
  const once = mirrorLeftHandedReplay(source);
  const twice = mirrorLeftHandedReplay({ ...once, metadata: { ...once.metadata, leftHanded: true } });
  expect(twice.metadata).toEqual({ ...source.metadata, leftHanded: false });
  expect(twice.notes).toEqual(source.notes);
  expect(twice.walls).toEqual(source.walls);
  for (const [index, pose] of source.poses.entries()) {
    const result = twice.poses[index];
    if (result === undefined) throw new Error('missing pose');
    expectCloseTransform(result.head, pose.head);
    expectCloseTransform(result.leftHand, pose.leftHand);
    expectCloseTransform(result.rightHand, pose.rightHand);
  }
});
