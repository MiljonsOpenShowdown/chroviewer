import { expect, test } from 'vite-plus/test';

import { createDifficulty, type Obstacle } from '../beatmap/types';
import { buildMapRenderData } from './map-render-data';

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
