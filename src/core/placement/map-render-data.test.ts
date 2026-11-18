import { expect, test } from 'vite-plus/test';

import { createDifficulty, type Obstacle } from '../beatmap/types';
import type { ReplayNoteEvent } from '../replay/types';
import { buildMapRenderData, buildMultiReplayMapRenderData } from './map-render-data';

function obstacle(overrides: Partial<Obstacle> = {}): Obstacle {
  return {
    jsonTime: 1,
    songBpmTime: 1,
    rotation: 0,
    posX: 0,
    posY: 0,
    type: 0,
    duration: 1,
    durationSongBpmTime: 1,
    width: 1,
    height: 5,
    customFake: false,
    ...overrides,
  };
}

test('classifies only player-affecting obstacles as gameplay walls', () => {
  const difficulty = createDifficulty('3.0.0');
  difficulty.obstacles = [
    obstacle(),
    obstacle({ customFake: true }),
    obstacle({ customData: { uninteractable: true } }),
  ];

  const data = buildMapRenderData(difficulty, {
    noteJumpSpeed: 10,
    noteStartBeatOffset: 0,
    songBpm: 120,
  });

  expect(data.walls.map((wall) => wall.interactable)).toEqual([true, false, false]);
});

function replayEvent(time: number, noteTime: number, overrides: Partial<ReplayNoteEvent> = {}): ReplayNoteEvent {
  return {
    noteId: { time: noteTime, lineLayer: 0, lineIndex: 1, colorType: 0, cutDirection: 1 },
    eventType: 1,
    cutPoint: { x: 0, y: 0, z: 0 },
    cutNormal: { x: 0, y: 0, z: 0 },
    saberDirection: { x: 0, y: 0, z: 0 },
    saberType: 0,
    directionOk: true,
    saberSpeed: 4,
    cutAngle: 0,
    cutDistanceToCenter: 0,
    cutDirectionDeviation: 0,
    beforeCutRating: 1,
    afterCutRating: 1,
    time,
    unityTimescale: 1,
    timeSyncTimescale: 1,
    ...overrides,
  };
}

function noteDifficulty() {
  const difficulty = createDifficulty('3.0.0');
  // 120 BPM: beats 4 and 6 are 2 s and 3 s into the song.
  difficulty.notes = [4, 6].map((beat) => ({
    jsonTime: beat,
    songBpmTime: beat,
    posX: 1,
    posY: 0,
    type: 0,
    cutDirection: 1,
    angleOffset: 0,
    rotation: 0,
    customFake: false,
  }));
  return difficulty;
}

const noteOptions = { noteJumpSpeed: 10, noteStartBeatOffset: 0, songBpm: 120 };

test('single replay output matches buildMultiReplayMapRenderData with one player', () => {
  const difficulty = noteDifficulty();
  const replayNotes = [replayEvent(2.1, 2), replayEvent(3.2, 3, { eventType: 3 })];
  const single = buildMapRenderData(difficulty, { ...noteOptions, replayNotes });
  const multi = buildMultiReplayMapRenderData(difficulty, noteOptions, [replayNotes]);

  // Each build owns its own movementStateAt closure, so compare it by behavior.
  const { movementStateAt: multiState, ...multiRest } = multi.data;
  const { movementStateAt: singleState, ...singleRest } = single;
  expect(multiRest).toEqual(singleRest);
  expect(multiState?.(4)).toEqual(singleState?.(4));
  expect(single.notes.map((note) => note.replayEndTime)).toEqual([2.1, 3.2]);
  expect(single.notes.map((note) => note.replayEventType)).toEqual([1, 3]);
  expect(replayNotes).toHaveLength(2);
});

test('a note ends at the earliest cut across players', () => {
  const difficulty = noteDifficulty();
  const playerA = [replayEvent(2.2, 2)];
  const playerB = [replayEvent(2.05, 2, { eventType: 2 })];
  const { data, playerResults } = buildMultiReplayMapRenderData(difficulty, noteOptions, [playerA, playerB]);

  expect(data.notes[0]?.replayEndTime).toBe(2.05);
  expect(data.notes[0]?.replayEventType).toBe(2);
  expect(data.notes[1]?.replayEndTime).toBeUndefined();
  expect(playerResults.map((results) => results.map((result) => [result.kind, result.index, result.outcome]))).toEqual([
    [['note', 0, 'hit']],
    [['note', 0, 'badCut']],
  ]);
  expect(playerResults[0]?.[0]?.score).toBe(115);
  expect(playerResults[1]?.[0]?.score).toBe(0);
});

test('a cut by one player wins over a miss by another, whatever the times', () => {
  const difficulty = noteDifficulty();
  const miss = [replayEvent(2.0, 2, { eventType: 3 }), replayEvent(3.0, 3, { eventType: 3 })];
  const hit = [replayEvent(2.1, 2)];
  const { data, playerResults } = buildMultiReplayMapRenderData(difficulty, noteOptions, [miss, hit]);

  expect(data.notes.map((note) => note.replayEndTime)).toEqual([2.1, 3.0]);
  expect(data.notes.map((note) => note.replayEventType)).toEqual([1, 3]);
  expect(playerResults[0]?.map((result) => result.outcome)).toEqual(['miss', 'miss']);
  expect(playerResults[1]?.map((result) => result.outcome)).toEqual(['hit']);
});
