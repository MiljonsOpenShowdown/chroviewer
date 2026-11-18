/**
 * AI Play driven by the embedding page (/overlay?parentControl=true): it never
 * starts on its own. The parent arms it with play, disarms it with pause, and
 * seeks; a seek past what the AI has generated waits until it gets there.
 */
export interface AiParentControl {
  /** The parent asked to play; playback starts once enough is generated. */
  armed: boolean;
  /** A seek not applied yet: past the generation edge, or sent before the view was ready. */
  target: number | null;
}

export interface AiParentControlStep {
  /** Song time to seek to now, or null. */
  seek: number | null;
  play: boolean;
  pause: boolean;
}

/**
 * What to do on one tick. `edge` is the song time generated so far (Infinity
 * once the AI has finished), `now` the playhead, `lead` the seconds that must
 * be generated ahead of the playhead before playback starts. Clears
 * `control.target` once it is applied.
 */
export function aiParentControlStep(
  control: AiParentControl,
  edge: number,
  now: number,
  playing: boolean,
  lead: number,
): AiParentControlStep {
  const step: AiParentControlStep = { seek: null, play: false, pause: false };
  let playhead = now;
  if (control.target !== null) {
    if (control.target > edge) {
      // Not generated yet: hold still until the AI reaches it
      step.pause = playing;
      return step;
    }
    step.seek = control.target;
    playhead = control.target;
    control.target = null;
  }
  if (!control.armed) {
    step.pause = playing;
    return step;
  }
  if (playing) {
    // The existing safety: never play past the generated play
    if (playhead >= edge) step.pause = true;
    return step;
  }
  step.play = edge - playhead >= lead;
  return step;
}
