import { z } from 'zod';

/**
 * `beatkhana:audio-fx` on /overlay: fades the song (not hitsounds) and muffles
 * it with a low-pass filter, e.g. to keep a map playing quietly under other
 * graphics. Values ramp from where they are over rampMs. The effect stays
 * through seeks, play, pause and a new multiview config, until the next
 * audio-fx message or a reload.
 */
const audioFxMessageSchema = z.object({
  type: z.literal('beatkhana:audio-fx'),
  version: z.literal(1),
  /** Multiplier on the song's output, 0 to 1; 1 is unchanged. */
  volume: z.number().min(0).max(1),
  /** Low-pass cutoff in Hz (20 up to the output's Nyquist frequency); null opens the filter fully. */
  lowpassHz: z.number().min(20).max(96000).nullable(),
  /** Ramp duration in milliseconds, 0 (instant) to 60000. */
  rampMs: z.number().min(0).max(60000),
});

export type AudioFxMessage = z.infer<typeof audioFxMessageSchema>;

/** The message as an AudioFxMessage, or null when it is not a valid audio-fx message. */
export function parseAudioFxMessage(data: unknown): AudioFxMessage | null {
  const parsed = audioFxMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
