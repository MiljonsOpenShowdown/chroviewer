/// <reference lib="webworker" />
// Built-in AI player. Runs the replay_ai model (public/ai/model.onnx) with
// onnxruntime-web, scores the generated motion in the sim, and posts
// ReplayStreamPackets that the live viewer plays exactly like a real stream.

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import * as ort from 'onnxruntime-web/wasm';

import {
  ENVIRONMENT_FEATURES,
  HISTORY_FRAMES,
  MODEL_INPUT_FEATURES,
  NOTE_FEATURES,
  NOTE_SLOTS,
  type PositionStats,
  PREDICTION_FRAMES,
} from './ai-features';
import { generateChunks, generationDuration, reconstructFrames, seededGaussian } from './ai-generate';
import type { AiMapData } from './ai-map';
import { AiStreamBuilder } from './ai-stream';
import type { FromAiWorker, ToAiWorker } from './ai-worker-protocol';

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Multi-threaded WASM needs cross-origin isolation, which the viewer doesn't enable.
ort.env.wasm.numThreads = 1;

interface Model {
  session: ort.InferenceSession;
  stats: PositionStats;
  seed: number[];
}

let start: Extract<ToAiWorker, { type: 'start' }> | null = null;
let model: Model | null = null;
let map: AiMapData | null = null;
let running = false;
let cancelled = false;

function post(message: FromAiWorker, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

function postPacket(bytes: Uint8Array) {
  const copy = bytes.slice().buffer;
  post({ type: 'packet', bytes: copy }, [copy]);
}

async function fetchOk(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${String(response.status)}`);
  return response;
}

async function loadModel(base: string): Promise<Model> {
  const version = (
    await fetch(`${base}/version.txt`, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : ''))
  ).trim();
  const v = version === '' ? '' : `?v=${encodeURIComponent(version)}`;
  const [modelBytes, stats, seed] = await Promise.all([
    fetchOk(`${base}/model.onnx${v}`).then((r) => r.arrayBuffer()),
    fetchOk(`${base}/stats.json${v}`).then((r) => r.json() as Promise<PositionStats>),
    fetchOk(`${base}/idle_seed.json${v}`).then((r) => r.json() as Promise<number[]>),
  ]);
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, stats, seed };
}

async function runChunk(history: Float32Array, notes: Float32Array, environment: Float32Array) {
  if (model === null) throw new Error('AI model not loaded');
  const session = model.session;
  const output = await session.run({
    history: new ort.Tensor('float32', history, [1, HISTORY_FRAMES, MODEL_INPUT_FEATURES]),
    notes: new ort.Tensor('float32', notes, [1, NOTE_SLOTS, NOTE_FEATURES]),
    environment: new ort.Tensor('float32', environment, [1, PREDICTION_FRAMES, ENVIRONMENT_FEATURES]),
  });
  const prediction = output.prediction ?? Object.values(output)[0];
  if (prediction === undefined) throw new Error('AI model has no output');
  return new Float32Array(prediction.data as Float32Array);
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run() {
  if (running || start === null || model === null || map === null) return;
  running = true;
  const builder = new AiStreamBuilder({
    streamId: start.streamId,
    playerId: start.playerId,
    mapHash: start.mapHash,
    difficultyRank: start.difficultyRank,
    characteristic: start.characteristic,
    simNotes: map.simNotes,
    njs: map.njs,
    height: start.height,
  });
  const songSeconds = generationDuration(map.notes);
  post({ type: 'status', status: 'generating', generatedSeconds: 0, songSeconds });

  // Every chunk is released as soon as it is final; the map preview
  // (useAiPreview) holds playback at the generation edge.
  let sent = 0;
  let ended = false;
  const pace = () => {
    if (cancelled || ended) return;
    for (;;) {
      const next = builder.nextChunkPacket();
      if (next === null) {
        if (builder.finished && builder.totalChunks !== null && sent >= builder.totalChunks) {
          ended = true;
          postPacket(builder.endPacket());
          post({ type: 'status', status: 'done', generatedSeconds: songSeconds, songSeconds });
        }
        break;
      }
      postPacket(next.bytes);
      sent++;
    }
    if (!ended) setTimeout(pace, 50);
  };
  setTimeout(pace, 50);

  let index = 0;
  const chunks = generateChunks(runChunk, {
    notes: map.notes,
    walls: map.walls,
    seed: model.seed,
    stats: model.stats,
    height: start.height,
    random: seededGaussian(0),
  });
  for await (const chunk of chunks) {
    if (cancelled) return;
    const frames = reconstructFrames(chunk, model.stats, index);
    index += PREDICTION_FRAMES;
    builder.addFrames(frames);
    const generated = frames[frames.length - 1]?.time ?? 0;
    post({ type: 'status', status: 'generating', generatedSeconds: generated, songSeconds });
    // Let the pacer run between model calls.
    await nextTask();
  }
  builder.finish();
}

self.onmessage = (event: MessageEvent<ToAiWorker>) => {
  const message = event.data;
  if (message.type === 'stop') {
    cancelled = true;
    return;
  }
  if (message.type === 'map') {
    map = message.data;
    void run().catch(fail);
    return;
  }
  start = message;
  postPacket(
    new AiStreamBuilder({
      streamId: message.streamId,
      playerId: message.playerId,
      mapHash: message.mapHash,
      difficultyRank: message.difficultyRank,
      characteristic: message.characteristic,
      simNotes: [],
      njs: 0,
      height: message.height,
    }).startPacket(),
  );
  post({ type: 'status', status: 'loading' });
  loadModel(message.modelBase)
    .then((loaded) => {
      model = loaded;
      if (map === null) post({ type: 'status', status: 'waiting-map' });
      return run();
    })
    .catch(fail);
};

function fail(error: unknown) {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}
