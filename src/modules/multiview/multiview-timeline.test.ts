import { describe, expect, test } from 'vite-plus/test';

import { advanceMultiviewCorrection, MultiviewTimeline, multiviewAudioOwner } from './multiview-timeline';

const base = {
  beat: 20,
  bpm: 120,
  duration: 100,
  mapHash: 'ABC',
  mapTitle: 'Map',
  playbackRate: 1,
  playing: true,
  syncReady: true,
  time: 10,
};

describe('multiview timeline', () => {
  test('supports a 200 ms drift trigger observed every two seconds', () => {
    const first = advanceMultiviewCorrection(undefined, 0.21, 0, 0.2);
    expect(first.correct).toBe(false);
    expect(advanceMultiviewCorrection(first.state, 0.21, 2000, 0.2).correct).toBe(true);
    expect(advanceMultiviewCorrection(first.state, 0.21, 4000, 0.2).correct).toBe(false);
    expect(advanceMultiviewCorrection(undefined, 0.19, 4000, 0.2).correct).toBe(false);
  });
  test('assigns audio to exactly one highest-volume player', () => {
    expect(
      multiviewAudioOwner([
        { id: 'one', masterVolume: 0.4 },
        { id: 'two', masterVolume: 0.8 },
        { id: 'three', masterVolume: 0.8 },
      ]),
    ).toBe('two');
    expect(multiviewAudioOwner([{ id: 'muted', masterVolume: 0 }])).toBeNull();
  });

  test('observes the slowest healthy player without overriding per-player clocks', () => {
    const timeline = new MultiviewTimeline();
    timeline.configure([
      { id: 'one', masterVolume: 0.25 },
      { id: 'two', masterVolume: 0.75 },
    ]);
    timeline.update('one', { ...base, beat: 18, time: 9 }, 1_000);
    timeline.update('two', base, 1_000);

    expect(timeline.sampleFor('two', 1_500)).toMatchObject({ id: 'two', time: 10.5, beat: 21 });
    expect(timeline.primary(1_500)).toMatchObject({ id: 'one', time: 9.5, beat: 19 });
    expect(timeline.ownSample('two', 1_500)).toMatchObject({ id: 'two', time: 10.5, beat: 21 });
  });

  test('does not let a buffering player hold back healthy players', () => {
    const timeline = new MultiviewTimeline();
    timeline.configure([
      { id: 'one', masterVolume: 0 },
      { id: 'two', masterVolume: 1 },
    ]);
    timeline.update('one', { ...base, syncReady: false, time: 5 }, 1_000);
    timeline.update('two', base, 1_000);

    expect(timeline.primary(1_500)).toMatchObject({ id: 'two', time: 10.5 });
  });

  test('keeps the anchor stable inside the half-second sync window', () => {
    const timeline = new MultiviewTimeline();
    timeline.configure([
      { id: 'one', masterVolume: 0 },
      { id: 'two', masterVolume: 1 },
    ]);
    timeline.update('one', { ...base, time: 9.95 }, 1_000);
    timeline.update('two', base, 1_000);
    expect(timeline.primary(1_000)?.id).toBe('one');

    timeline.update('one', { ...base, time: 10.45 }, 1_100);
    timeline.update('two', { ...base, time: 10 }, 1_100);
    expect(timeline.primary(1_100)?.id).toBe('one');
  });

  test('corrects sustained drift only once until clocks converge', () => {
    let state = advanceMultiviewCorrection(undefined, 0.49, 0).state;
    expect(advanceMultiviewCorrection(state, 0.49, 10_000).correct).toBe(false);

    let result = advanceMultiviewCorrection(state, 0.6, 10_100);
    state = result.state;
    expect(result.correct).toBe(false);
    result = advanceMultiviewCorrection(state, 0.6, 11_101);
    state = result.state;
    expect(result.correct).toBe(true);
    expect(advanceMultiviewCorrection(state, 0.6, 20_000).correct).toBe(false);

    state = advanceMultiviewCorrection(state, 0.1, 20_100).state;
    result = advanceMultiviewCorrection(state, 0.6, 20_200);
    expect(result.correct).toBe(false);
    expect(advanceMultiviewCorrection(result.state, 0.6, 21_201).correct).toBe(true);
  });

  test('does not apply a different map timeline to a player', () => {
    const timeline = new MultiviewTimeline();
    timeline.configure([
      { id: 'one', masterVolume: 0 },
      { id: 'two', masterVolume: 1 },
    ]);
    timeline.update('one', { ...base, mapHash: 'OTHER', time: 4, beat: 8 }, 1_000);
    timeline.update('two', base, 1_000);

    expect(timeline.sampleFor('one', 1_500)).toMatchObject({ id: 'one', time: 4.5, beat: 9 });
  });
});
