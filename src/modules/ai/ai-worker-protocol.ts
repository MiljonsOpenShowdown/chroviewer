import type { AiMapData } from './ai-map';

/** Drop folder served by the viewer (public/ai). Replace its files to update the AI. */
export const AI_MODEL_BASE = '/ai';
/** Generation head start before the AI stream starts playing. */
export const AI_BUFFER_SECONDS = 5;
// Live player ids are numeric in the viewer's URL schema; 0 is never a real platform id.
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
      bufferSeconds: number;
      height: number;
    }
  | { type: 'map'; data: AiMapData }
  | { type: 'stop' };

export type AiWorkerStatus = 'loading' | 'waiting-map' | 'generating' | 'done';

export type FromAiWorker =
  | { type: 'packet'; bytes: ArrayBuffer }
  | { type: 'status'; status: AiWorkerStatus; generatedSeconds?: number; songSeconds?: number }
  | { type: 'error'; message: string };
