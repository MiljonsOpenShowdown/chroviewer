import { describe, expect, test, vi } from 'vite-plus/test';

import { createAudioClock, createClock, oggVorbisDuration } from './song-clock';

/** An Ogg page with one segment of `body`, at `granule`. */
function oggPage(granule: bigint, body: number[]) {
  const page = new Uint8Array(28 + body.length);
  page.set([0x4f, 0x67, 0x67, 0x53, 0]);
  new DataView(page.buffer).setBigInt64(6, granule, true);
  page[26] = 1;
  page[27] = body.length;
  page.set(body, 28);
  return page;
}

function oggFile(sampleRate: number, granules: bigint[]) {
  const header = Array.from({ length: 30 }, () => 0);
  header.splice(0, 7, 0x01, ...new TextEncoder().encode('vorbis'));
  header.splice(12, 4, ...new Uint8Array(new Uint32Array([sampleRate]).buffer));
  const pages = [oggPage(0n, header), ...granules.map((granule) => oggPage(granule, [1, 2, 3]))];
  const bytes = new Uint8Array(pages.reduce((length, page) => length + page.length, 0));
  pages.reduce((offset, page) => (bytes.set(page, offset), offset + page.length), 0);
  return bytes.buffer;
}

describe('Ogg Vorbis length', () => {
  test('is the last granule position over the sample rate', () => {
    expect(oggVorbisDuration(oggFile(44_100, [44_100n, 44_100n * 90n]))).toBe(90);
  });

  test('skips a last page without a granule position', () => {
    expect(oggVorbisDuration(oggFile(48_000, [48_000n * 30n, -1n]))).toBe(30);
  });

  test('is null for other audio', () => {
    expect(oggVorbisDuration(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]).buffer)).toBeNull();
  });
});

function fixture(rate = 1, offset = 0) {
  let now = 0;
  const driver = { now: () => now, start: vi.fn(), stop: vi.fn(), setRate: vi.fn() };
  const clock = createClock(180, 120, driver);
  clock.setRate(rate);
  clock.setAudioOffset(offset);
  return {
    clock,
    driver,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

describe('continuous replay synchronization', () => {
  test('eight players converge without jumping backwards or restarting audio at two-second checks', () => {
    const players = Array.from({ length: 8 }, (_, index) => {
      const player = fixture(1, 0.2);
      player.clock.seek(10 + index * 0.05);
      player.clock.play();
      return player;
    });
    const previous = players.map(({ clock }) => clock.currentTime());
    for (let tick = 0; tick < 300; tick++) {
      for (const player of players) player.advance(0.1);
      const target = players[0]?.clock.currentTime() ?? 0;
      players.forEach(({ clock }, index) => {
        // Corrections run continuously after drift is observed, independently
        // of the two-second detection cadence.
        if (tick >= 20) clock.correctDrift(target);
        expect(clock.currentTime()).toBeGreaterThan(previous[index] ?? 0);
        expect(clock.currentTime() - (previous[index] ?? 0)).toBeLessThanOrEqual(0.100001);
        expect(clock.getRate()).toBeGreaterThanOrEqual(0.95);
        expect(clock.getRate()).toBeLessThanOrEqual(1.05);
        previous[index] = clock.currentTime();
      });
    }
    for (const { clock, driver } of players) {
      expect(clock.currentTime()).toBeCloseTo(players[0]?.clock.currentTime() ?? 0, 1);
      expect(driver.start).toHaveBeenCalledTimes(1);
      expect(driver.stop).not.toHaveBeenCalled();
      expect(clock.getRate()).toBe(1);
    }
  });

  test('corrects a lagging clock while preserving the nominal song speed', () => {
    const { clock, driver, advance } = fixture(1.2);
    clock.play();
    advance(1);
    const before = clock.currentTime();
    clock.correctDrift(before + 0.2);
    expect(clock.currentTime()).toBe(before);
    expect(clock.getRate()).toBeCloseTo(1.26);
    advance(1);
    expect(clock.currentTime()).toBeCloseTo(before + 1.26);
    clock.correctDrift(clock.currentTime());
    expect(clock.getRate()).toBe(1.2);
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.stop).not.toHaveBeenCalled();
  });

  test('pause and explicit seek end a temporary correction; invalid targets are ignored', () => {
    const { clock, advance } = fixture();
    clock.play();
    advance(5);
    clock.correctDrift(4);
    expect(clock.getRate()).toBe(0.95);
    clock.pause();
    expect(clock.getRate()).toBe(1);
    clock.play();
    clock.correctDrift(Number.NaN);
    expect(clock.getRate()).toBe(1);
    clock.correctDrift(4);
    clock.seek(10);
    expect(clock.getRate()).toBe(1);
    expect(clock.currentTime()).toBe(10);
  });
});

/** An AudioParam that records its automation calls. */
function fakeParam(value: number) {
  const calls: [string, number, number][] = [];
  return {
    value,
    calls,
    cancelScheduledValues: vi.fn(),
    setValueAtTime(next: number, at: number) {
      calls.push(['set', next, at]);
    },
    linearRampToValueAtTime(next: number, at: number) {
      calls.push(['linear', next, at]);
    },
    exponentialRampToValueAtTime(next: number, at: number) {
      calls.push(['exponential', next, at]);
    },
  };
}

function fakeNode(param: ReturnType<typeof fakeParam>, name: string, edges: string[]) {
  return {
    name,
    gain: param,
    frequency: param,
    type: '',
    connect(target: { name: string }) {
      edges.push(`${name}->${target.name}`);
    },
    disconnect: vi.fn(),
  };
}

function fakeAudioContext() {
  const edges: string[] = [];
  const gains: ReturnType<typeof fakeParam>[] = [];
  const filters: ReturnType<typeof fakeNode>[] = [];
  const sources: ReturnType<typeof fakeNode>[] = [];
  const context = {
    name: 'destination',
    currentTime: 5,
    sampleRate: 48_000,
    state: 'running',
    destination: { name: 'destination' },
    decodeAudioData: async () => ({ duration: 120 }),
    resume: async () => {},
    close: async () => {},
    createGain() {
      const param = fakeParam(1);
      gains.push(param);
      return fakeNode(param, `gain${gains.length}`, edges);
    },
    createBiquadFilter() {
      const node = fakeNode(fakeParam(350), 'lowpass', edges);
      filters.push(node);
      return node;
    },
    createBufferSource() {
      const node = {
        ...fakeNode(fakeParam(1), 'source', edges),
        playbackRate: { value: 1 },
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(node);
      return node;
    },
  };
  return { context, edges, gains, filters, sources };
}

describe('song effects', () => {
  test('route the song through the effects gain and low-pass and ramp both without jumps', async () => {
    const fake = fakeAudioContext();
    const result = await createAudioClock({
      audioData: new ArrayBuffer(8),
      songBpm: 120,
      context: fake.context as unknown as AudioContext,
    });
    const clock = result.unwrap();
    expect(fake.filters[0]?.type).toBe('lowpass');
    // Opens at the Nyquist frequency
    expect(fake.filters[0]?.frequency.value).toBe(24_000);
    clock.play();
    expect(fake.edges).toEqual(['gain1->gain2', 'gain2->lowpass', 'lowpass->destination', 'source->gain1']);

    const effects = fake.gains[1];
    const frequency = fake.filters[0]?.frequency;
    if (effects === undefined || frequency === undefined) throw new Error('missing nodes');
    effects.value = 0.8;
    frequency.value = 24_000;
    clock.setEffects(0.3, 800, 1.5);
    expect(effects.calls).toEqual([
      ['set', 0.8, 5],
      ['linear', 0.3, 6.5],
    ]);
    expect(frequency.calls).toEqual([
      ['set', 24_000, 5],
      ['exponential', 800, 6.5],
    ]);

    // Seeking restarts the source on the same effect nodes
    clock.seek(30);
    expect(fake.edges.filter((edge) => edge === 'source->gain1')).toHaveLength(2);

    effects.calls.length = 0;
    frequency.calls.length = 0;
    effects.value = 0.3;
    frequency.value = 800;
    clock.setEffects(1, null, 0);
    expect(effects.calls.at(-1)).toEqual(['set', 1, 5]);
    expect(frequency.calls.at(-1)).toEqual(['set', 24_000, 5]);
    clock.dispose();
  });
});
