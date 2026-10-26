import type { AiMapData } from './ai-map';

/** Drop folder served by the viewer (public/ai). Replace its files to update the AI. */
export const AI_MODEL_BASE = '/ai';
// Player id inside the AI's replay stream; 0 is never a real platform id.
export const AI_PLAYER_ID = '0';

export type ToAiWorker =
  | {
      type: 'start';
      streamId: string;
      playerId: string;
      mapHash: string;
      difficulty: string;
      difficultyRank: number;
      characteristic: string;
      modelBase: string;
      height: number;
    }
  | { type: 'map'; data: AiMapData }
  | { type: 'stop' };

export type AiWorkerStatus = 'loading' | 'waiting-map' | 'generating' | 'done';

/** base = model.onnx; specialist = the map's own model from public/ai/specialists. */
export type AiModelKind = 'base' | 'specialist';

export type FromAiWorker =
  | { type: 'packet'; bytes: ArrayBuffer }
  | { type: 'status'; status: AiWorkerStatus; generatedSeconds?: number; songSeconds?: number; model?: AiModelKind }
  | { type: 'error'; message: string };
