import { z } from 'zod';

/**
 * `beatkhana:multiview-control` as the single /overlay AI preview takes it
 * (with parentControl=true): play, pause and seek. Other actions (rate, sync)
 * are ignored, and so is a seek's tileId, as there is only one view.
 */
const previewControlSchema = z.discriminatedUnion('action', [
  z.object({ type: z.literal('beatkhana:multiview-control'), version: z.literal(1), action: z.literal('play') }),
  z.object({ type: z.literal('beatkhana:multiview-control'), version: z.literal(1), action: z.literal('pause') }),
  z.object({
    type: z.literal('beatkhana:multiview-control'),
    version: z.literal(1),
    action: z.literal('seek'),
    /** Song time in seconds. */
    time: z.number().min(0),
  }),
]);

export type PreviewControlMessage = z.infer<typeof previewControlSchema>;

/** The message as a PreviewControlMessage, or null when it is not one the preview acts on. */
export function parsePreviewControlMessage(data: unknown): PreviewControlMessage | null {
  const parsed = previewControlSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** About five times a second, the AI preview's state for the parent. */
export interface PreviewStateMessage {
  type: 'beatkhana:preview-state';
  version: 1;
  /** The map, song and AI play are loaded and shown: seeks apply from here on. */
  ready: boolean;
  time: number;
  playing: boolean;
  /** Song time the AI's play is generated up to; the song's duration once it is done. */
  generatedUntil: number;
  duration: number;
}
