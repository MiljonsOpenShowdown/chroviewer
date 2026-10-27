import { Group, Object3D } from 'three';
import { expect, test } from 'vite-plus/test';

import type { VectorPoint } from '../../core/animation/point-definition';
import type { ChromaTrackAnimation } from '../../core/chroma-environment';
import { EMPTY_NOODLE_BEATMAP, type NoodleBeatmapData, type NoodleParentEvent } from '../../core/noodle-data';
import type { LoadedEnvironment } from '../environment/environment-runtime';
import { ChromaTrackRuntime } from './chroma-track-runtime';

const properties = ['position', 'localPosition', 'rotation', 'localRotation', 'scale'] as const;

/** Deterministic pseudo random numbers, so both scenes get the same map. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function points(next: () => number, count: number): VectorPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    value: [next() * 10 - 5, next() * 10 - 5, next() * 10 - 5],
    time: count === 1 ? 0 : index / (count - 1),
    spline: false,
  }));
}

/**
 * A Chroma environment of `count` objects, each on its own track, under a
 * moving and a still parent, with some objects nested in other tracked ones.
 * Every track gets a few animations over `beats`, so most are idle at a time.
 */
function scene(count: number, beats: number, seed = 1) {
  const next = random(seed);
  const root = new Group();
  // Moved by "another system" (rings, light rotations) every frame
  const moving = new Group();
  const still = new Group();
  still.position.set(1, 2, 3);
  still.rotation.set(0.3, 0.2, 0.1);
  root.add(moving, still);
  const targets: Object3D[] = [];
  const chromaTracks = new Map<string, Object3D[]>();
  const animations: ChromaTrackAnimation[] = [];
  for (let index = 0; index < count; index++) {
    const target = new Object3D();
    target.position.set(next(), next(), next());
    // Every seventh object is a child of the one before
    const parent = (index % 7 === 6 ? targets[index - 1] : undefined) ?? (index % 3 === 0 ? moving : still);
    parent.add(target);
    targets.push(target);
    const track = `t${index}`;
    chromaTracks.set(track, [target]);
    for (let event = 0; event < 3; event++) {
      const property = properties[Math.floor(next() * properties.length)] ?? 'position';
      const duration = 4 + Math.floor(next() * 28);
      animations.push({
        jsonTime: 0,
        songBpmTime: Math.floor(next() * beats),
        duration,
        durationSongBpmTime: duration,
        track: [track],
        repeat: Math.floor(next() * 3),
        [property]: points(next, 2 + Math.floor(next() * 2)),
      });
    }
  }
  animations.sort((left, right) => left.songBpmTime - right.songBpmTime);
  const environment = {
    root,
    data: { fogParams: {} },
    chromaEnvironment: {
      version: 3,
      materials: {},
      enhancements: [],
      animations,
      componentAnimations: [],
      fogTrackEvents: [],
    },
    chromaTracks,
  } as unknown as LoadedEnvironment;
  const runtime = new ChromaTrackRuntime();
  runtime.rebuild(environment);
  return { root, moving, targets, runtime };
}

/**
 * Noodle data with a parent event for no track of the scene: changes nothing,
 * but the runtime then samples every object every frame, as before skipping.
 */
const sampleEveryFrame: NoodleBeatmapData = {
  ...EMPTY_NOODLE_BEATMAP,
  parentEvents: [
    {
      jsonTime: 0,
      songBpmTime: 0,
      parentTrack: 'unused-parent',
      childrenTracks: ['unused-child'],
      worldPositionStays: false,
      transform: {},
    } as unknown as NoodleParentEvent,
  ],
};

test('skipping settled objects gives the same transforms as sampling every frame', () => {
  const beats = 200;
  const skipped = scene(120, beats);
  const reference = scene(120, beats);
  const frame = (beat: number) => {
    for (const { moving } of [skipped, reference]) {
      moving.rotation.y = beat * 0.05;
      moving.position.x = Math.sin(beat);
    }
    skipped.runtime.update(beat);
    reference.runtime.update(beat, sampleEveryFrame);
    skipped.root.updateMatrixWorld(true);
    reference.root.updateMatrixWorld(true);
    for (const [index, target] of skipped.targets.entries()) {
      expect(target.matrixWorld.elements, `object ${index} at beat ${beat}`).toEqual(
        reference.targets[index]?.matrixWorld.elements,
      );
    }
  };
  for (let beat = 0; beat < beats + 40; beat += 0.25) frame(beat);
  // Seeking back, and another system moving tracked objects, are picked up
  for (let beat = 60; beat < 90; beat += 0.25) {
    if (beat === 70) {
      for (const { targets } of [skipped, reference]) {
        targets[1]?.position.set(9, 9, 9);
        targets[2]?.scale.set(2, 2, 2);
      }
    }
    frame(beat);
  }
  // A few seconds alone; more while the whole suite runs in parallel
}, 30_000);

test.skipIf(process.env.CHROMA_BENCH === undefined)(
  'benchmark',
  () => {
    const beats = 600;
    for (const [label, noodle] of [
      ['skipping', undefined],
      ['every frame', sampleEveryFrame],
    ] as const) {
      const { moving, runtime } = scene(3000, beats);
      const start = performance.now();
      let frames = 0;
      for (let beat = 0; beat < beats; beat += 0.5, frames++) {
        moving.rotation.y = beat * 0.05;
        runtime.update(beat, noodle);
      }
      console.log(`${label}: ${((performance.now() - start) / frames).toFixed(3)} ms/frame`);
    }
  },
  600_000,
);
