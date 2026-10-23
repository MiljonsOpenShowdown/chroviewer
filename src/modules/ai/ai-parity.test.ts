import { readFileSync } from 'node:fs';

import { fromBinary } from '@bufbuild/protobuf';
import * as ort from 'onnxruntime-web/wasm';
import { describe, expect, test } from 'vite-plus/test';

import { parseDifficulty } from '../../core/beatmap/parse';
import { ReplayStreamPacketSchema } from '../live/generated/proto/scoresaber/live/v1/replay_stream_pb';
import { resampleFrames, simulateNotes } from './ai-cut-sim';
import {
  type AiNote,
  type AiWall,
  ENVIRONMENT_FEATURES,
  environmentFeatures,
  HISTORY_FRAMES,
  MODEL_INPUT_FEATURES,
  NOTE_FEATURES,
  NOTE_SLOTS,
  noteFeatures,
  PREDICTION_FRAMES,
} from './ai-features';
import { type AiFrame, anchorDrift, generateChunks } from './ai-generate';
import { aiMapData } from './ai-map';
import { AiStreamBuilder } from './ai-stream';
import { item } from './ai-util';

// Golden vectors come from the Python reference (CyberHawk:
// `python -m replay_ai.export_golden`), using the same public/ai/model.onnx.

interface Golden {
  map: { hash: string; difficulty: string; characteristic: string; songBpm: number; njs: number; dat: string };
  expectedNotes: number[][];
  expectedWalls: number[][];
  expectedSimNotes: [number, number][];
  seed: number[];
  stats: { mean: number[]; std: number[] };
  features: { time: number; notes: number[]; density: number; environment: number[] }[];
  generation: { chunks: number[][] };
  anchor: { home: [number, number]; input: number[]; expected: number[] };
  sim: {
    njs: number;
    frames: number[][];
    notes: [number, number][];
    results: {
      noteId: number;
      eventType: number;
      cutTime: number | null;
      saberType: number;
      score: number;
      before: number;
      after: number;
      cutDistance: number;
    }[];
  };
}

const golden = JSON.parse(readFileSync(new URL('./__fixtures__/golden.json', import.meta.url), 'utf8')) as Golden;
const notes = golden.expectedNotes as AiNote[];
const walls = golden.expectedWalls as AiWall[];

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance: number) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(item(actual, i) - item(expected, i)));
  expect(worst).toBeLessThanOrEqual(tolerance);
}

function toFrame(row: number[]): AiFrame {
  return {
    time: item(row, 0),
    headPos: [item(row, 1), item(row, 2), item(row, 3)],
    headRot: [item(row, 4), item(row, 5), item(row, 6), item(row, 7)],
    leftPos: [item(row, 8), item(row, 9), item(row, 10)],
    leftRot: [item(row, 11), item(row, 12), item(row, 13), item(row, 14)],
    rightPos: [item(row, 15), item(row, 16), item(row, 17)],
    rightRot: [item(row, 18), item(row, 19), item(row, 20), item(row, 21)],
  };
}

describe('built-in AI matches the Python reference', () => {
  test('map conversion from the viewer parser', () => {
    const difficulty = parseDifficulty(golden.map.dat, golden.map.songBpm);
    const data = aiMapData(difficulty, golden.map.songBpm, {
      hash: golden.map.hash,
      difficulty: golden.map.difficulty,
      characteristic: golden.map.characteristic,
      njs: golden.map.njs,
    });
    expect(data.notes.length).toBe(notes.length);
    expectClose(data.notes.flat(), notes.flat(), 1e-5);
    expect(data.walls.length).toBe(walls.length);
    expectClose(data.walls.flat(), walls.flat(), 1e-5);
    expect(data.simNotes.map((n) => n.noteId)).toEqual(golden.expectedSimNotes.map(([id]) => id));
    expectClose(
      data.simNotes.map((n) => n.time),
      golden.expectedSimNotes.map(([, time]) => time),
      1e-5,
    );
  });

  test('note and environment features', () => {
    for (const expected of golden.features) {
      const { features, density } = noteFeatures(notes, expected.time);
      expectClose(features, expected.notes, 1e-5);
      expect(density).toBeCloseTo(expected.density, 9);
      expectClose(environmentFeatures(walls, expected.time, density), expected.environment, 1e-6);
    }
  });

  test('generation through model.onnx (noise off)', async () => {
    const model = readFileSync(new URL('../../../public/ai/model.onnx', import.meta.url));
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(model);
    const run = async (history: Float32Array, noteInput: Float32Array, environment: Float32Array) => {
      const output = await session.run({
        history: new ort.Tensor('float32', history, [1, HISTORY_FRAMES, MODEL_INPUT_FEATURES]),
        notes: new ort.Tensor('float32', noteInput, [1, NOTE_SLOTS, NOTE_FEATURES]),
        environment: new ort.Tensor('float32', environment, [1, PREDICTION_FRAMES, ENVIRONMENT_FEATURES]),
      });
      const prediction = output.prediction;
      if (prediction === undefined) throw new Error('model has no prediction output');
      return new Float32Array(prediction.data as Float32Array);
    };
    const chunks: Float32Array[] = [];
    for await (const chunk of generateChunks(run, {
      notes,
      walls,
      seed: golden.seed,
      stats: golden.stats,
      random: null,
    })) {
      chunks.push(chunk);
      if (chunks.length === golden.generation.chunks.length) break;
    }
    golden.generation.chunks.forEach((expected, i) => expectClose(item(chunks, i), expected, 2e-3));
  }, 60_000);

  test('drift anchor', () => {
    const chunk = anchorDrift(Float32Array.from(golden.anchor.input), golden.anchor.home, golden.stats);
    expectClose(chunk, golden.anchor.expected, 1e-5);
  });

  test('cut simulation', () => {
    const frames = resampleFrames(golden.sim.frames.map(toFrame));
    const results = simulateNotes(
      frames,
      golden.sim.notes.map(([noteId, time]) => ({ noteId, time })),
      golden.sim.njs,
    );
    expect(results.length).toBe(golden.sim.results.length);
    results.forEach((result, i) => {
      const expected = item(golden.sim.results, i);
      expect(result.eventType).toBe(expected.eventType);
      expect(result.saberType).toBe(expected.saberType);
      expect(result.score).toBe(expected.score);
      if (expected.cutTime === null) expect(result.cutTime).toBeNull();
      else expect(result.cutTime).toBeCloseTo(expected.cutTime, 6);
      // Fixture frames are rounded to 7 digits, so ratings agree to ~1e-6.
      expect(result.beforeCutRating).toBeCloseTo(expected.before, 5);
      expect(result.afterCutRating).toBeCloseTo(expected.after, 5);
      expect(result.cutDistanceToCenter).toBeCloseTo(expected.cutDistance, 5);
    });
  });

  test('stream builder releases a complete, ordered stream', () => {
    const builder = new AiStreamBuilder({
      streamId: 'test',
      playerId: '0',
      mapHash: golden.map.hash,
      difficultyRank: 7,
      characteristic: 'Standard',
      simNotes: golden.sim.notes.map(([noteId, time]) => ({ noteId, time })),
      njs: golden.sim.njs,
      height: 1.65,
    });
    const frames = golden.sim.frames.map(toFrame);
    const packets: Uint8Array[] = [];
    const drain = () => {
      for (let next = builder.nextChunkPacket(); next !== null; next = builder.nextChunkPacket())
        packets.push(next.bytes);
    };
    for (let i = 0; i < frames.length; i += 120) {
      builder.addFrames(frames.slice(i, i + 120));
      drain();
    }
    builder.finish();
    drain();
    packets.push(builder.endPacket());

    const decoded = packets.map((bytes) => fromBinary(ReplayStreamPacketSchema, bytes));
    const chunks = decoded
      .filter((p) => p.body.case === 'chunk')
      .map(
        (p) =>
          p.body.value as { cursor?: { sequence: bigint }; events?: { poseFrames: unknown[]; noteEvents: unknown[] } },
      );
    chunks.forEach((chunk, i) => expect(chunk.cursor?.sequence).toBe(BigInt(i + 1)));
    expect(chunks.reduce((sum, c) => sum + (c.events?.poseFrames.length ?? 0), 0)).toBe(frames.length);
    const noteEvents = chunks.reduce((sum, c) => sum + (c.events?.noteEvents.length ?? 0), 0);
    expect(noteEvents).toBe(golden.sim.results.filter((r) => r.eventType !== 4).length);
    expect(decoded.at(-1)?.body.case).toBe('end');
    expect(builder.summary.goodCuts).toBe(golden.sim.results.filter((r) => r.eventType === 0).length);
  });
});
