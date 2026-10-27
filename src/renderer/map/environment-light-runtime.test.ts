import { Color, Group, Object3D, ShaderMaterial } from 'three';
import { expect, test } from 'vite-plus/test';

import { DEFAULT_COLORS, type ColorScheme, type Rgb } from '../../core/colors';
import type { EnvironmentLightBinding, LoadedEnvironment } from '../environment/environment-runtime';
import { EnvironmentLightRuntime } from './environment-light-runtime';

/** Deterministic pseudo random numbers, so both runtimes get the same map. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function material(colorProperty: string) {
  return new ShaderMaterial({
    uniforms: {
      [colorProperty]: { value: new Color(0, 0, 0) },
      [`${colorProperty}Alpha`]: { value: 0 },
      _ColorMultiplier: { value: 0 },
    },
  });
}

function binding(eventType: number, extra: Partial<EnvironmentLightBinding> = {}): EnvironmentLightBinding {
  return {
    eventType,
    offIntensity: 0,
    lightOnStart: false,
    invertColorScheme: false,
    lightId: 0,
    lightIdRemap: [],
    ...extra,
  };
}

/** Lights of every kind the runtime handles, over event types 0-4. */
function environment() {
  const root = new Group();
  const node = new Object3D();
  root.add(node);
  const materialLights = [
    { materials: [material('_Color'), material('_Color')], bindings: [binding(0)], intensityMultiplier: 1 },
    {
      materials: [material('_TintColor')],
      bindings: [binding(1, { invertColorScheme: true })],
      intensityMultiplier: 0.7,
      colorProperty: '_TintColor',
      minimumAlpha: 0.1,
    },
    {
      materials: [material('_Color')],
      bindings: [binding(2), binding(3)],
      intensityMultiplier: 1,
      node: new Object3D(),
      initialVisible: true,
    },
    {
      materials: [material('_Color')],
      bindings: [binding(4, { offIntensity: 0.2, lightOnStart: true })],
      intensityMultiplier: 1.2,
    },
    {
      materials: [material('_Color')],
      bindings: [],
      intensityMultiplier: 1,
      combined: {
        inputs: [
          { bindings: [binding(0)], intensity: 0.5 },
          { bindings: [binding(2)], intensity: 1 },
        ],
        intensity: 1,
        maxIntensity: 1.5,
        multiplyColorByAlpha: true,
        mixType: 0,
        setAlphaOnly: false,
        alphaIntoColor: false,
        setColorOnly: false,
      },
    },
    {
      materials: [material('_Color')],
      bindings: [binding(3)],
      intensityMultiplier: 1,
      node: new Object3D(),
      transform: (color: Rgb, alpha: number) => ({
        color: [color[1], color[2], color[0]] as Rgb,
        alpha: alpha * 0.5,
        visible: alpha > 0.2,
      }),
    },
  ];
  const segment = {
    start: [0, 0, 0],
    end: [0, 1, 0],
    color: [1, 1, 1],
    alpha: 1,
    intensityMultiplier: 1,
    bindings: [binding(1), binding(4)],
    node,
    localStart: [0, -0.5, 0],
    localEnd: [0, 0.5, 0],
    baseLength: 1,
    center: 0.5,
    multiplyLengthByAlpha: false,
  };
  return {
    root,
    lightSegments: [segment],
    materialLights,
    backgroundGradient: null,
    rotations: [],
    ringGroups: [],
    glsColorGroups: [],
    glsRotationGroups: [],
    glsTranslationGroups: [],
    glsFxGroups: [],
    eventSwitches: [],
    boostSwitches: [],
    directionalLights: [],
    data: { fogParams: {}, objects: [] },
    applyChromaRemoval: () => {},
    enforceChromaRemoval: () => {},
    applyConstraints: () => false,
    syncInstancedMeshes: () => {},
    applyReflections: () => {},
    dispose: () => {},
  } as unknown as LoadedEnvironment;
}

/**
 * Every light value (off, on, flash, fade, transition) on types 0-4, with
 * Chroma colors, gradients and eased transitions, and boosts on type 5.
 * Gaps between events are long enough for flashes and fades to settle.
 */
function map(beats: number) {
  const next = random(7);
  const lightEvents: Record<string, unknown>[] = [];
  for (let beat = 0; beat < beats; beat += 0.5 + Math.floor(next() * 8) * 0.5) {
    const type = Math.floor(next() * 5);
    const value = Math.floor(next() * 13);
    const event: Record<string, unknown> = {
      type,
      value,
      floatValue: 0.5 + next() * 0.5,
      songBpmTime: beat,
      jsonTime: beat,
    };
    const custom = next();
    if (custom < 0.2) event.customData = { color: [next(), next(), next(), 0.5 + next() * 0.5] };
    else if (custom < 0.3) {
      event.customData = {
        lightGradient: {
          duration: 1 + Math.floor(next() * 4),
          startColor: [next(), next(), next(), 1],
          endColor: [next(), next(), next(), 1],
          easing: 'easeInOutQuad',
        },
      };
    } else if (custom < 0.4) event.customData = { easing: 'easeOutCubic', lerpType: next() < 0.5 ? 'HSV' : 'RGB' };
    lightEvents.push(event);
    if (next() < 0.05) {
      lightEvents.push({ type: 5, value: next() < 0.5 ? 1 : 0, floatValue: 1, songBpmTime: beat, jsonTime: beat });
    }
  }
  return {
    lightEvents,
    bpmEvents: [],
    songBpm: 128,
    lightColorEventBoxGroups: [],
    lightRotationEventBoxGroups: [],
    lightTranslationEventBoxGroups: [],
    lightFxEventBoxGroups: [],
    environmentRemoval: [],
    rotationEvents: [],
  };
}

function scene(beats: number) {
  const loaded = environment();
  const runtime = new EnvironmentLightRuntime();
  // The map first: the test environment has no color scheme of its own
  runtime.setMap(map(beats) as never, DEFAULT_COLORS);
  runtime.setEnvironment(loaded);
  return { loaded, runtime };
}

function outputs({ loaded, runtime }: ReturnType<typeof scene>) {
  return {
    lights: loaded.materialLights.map((light) => ({
      visible: light.node?.visible,
      uniforms: light.materials.map((entry) =>
        Object.entries(entry.uniforms).map(([name, uniform]) => [
          name,
          uniform.value instanceof Color ? uniform.value.toArray() : uniform.value,
        ]),
      ),
    })),
    segments: runtime.lightSegments.map((segment) => [segment.color, segment.alpha, segment.endAlpha]),
  };
}

const otherColors: ColorScheme = {
  ...DEFAULT_COLORS,
  environmentLeft: [0.1, 0.9, 0.3],
  environmentRight: [0.8, 0.2, 0.7],
  environmentLeftBoost: [0.9, 0.6, 0.1],
};

test('keeping settled light samples gives the same lights as sampling every frame', () => {
  const beats = 160;
  const cached = scene(beats);
  const reference = scene(beats);
  // Counts sampling calls, to check the cache is actually used
  let samples = 0;
  const target = cached.runtime as unknown as { sampleEnvironmentLight: (...args: unknown[]) => unknown };
  const sample = target.sampleEnvironmentLight.bind(target);
  target.sampleEnvironmentLight = (...args) => {
    samples++;
    return sample(...args);
  };
  let frames = 0;
  const frame = (beat: number) => {
    // A new generation every frame: the reference runtime never reuses a sample
    (reference.runtime as unknown as { sampleGeneration: number }).sampleGeneration++;
    cached.runtime.update(beat);
    reference.runtime.update(beat);
    frames++;
    expect(outputs(cached), `beat ${beat}`).toEqual(outputs(reference));
  };
  const both = (change: (runtime: EnvironmentLightRuntime) => void) => {
    change(cached.runtime);
    change(reference.runtime);
  };
  for (let step = -20; step < (beats + 10) * 20; step++) {
    const beat = step / 20;
    if (step === 40 * 20) both((runtime) => runtime.setLightBrightness(0.6));
    if (step === 60 * 20) both((runtime) => runtime.setColors(otherColors));
    if (step === 80 * 20) both((runtime) => runtime.setLightshowMode('static'));
    if (step === 100 * 20) both((runtime) => runtime.setLightshowMode('none'));
    if (step === 110 * 20) both((runtime) => runtime.setLightshowMode('full'));
    frame(beat);
  }
  // Seeking back
  for (let step = 30 * 20; step < 50 * 20; step++) frame(step / 20);
  // Without the cache: 6 lights plus the combined light's 2 inputs, which always sample
  console.log(`sampled ${samples} times in ${frames} frames`);
  expect(samples).toBeLessThan(frames * (2 + 6 * 0.5));
}, 30_000);

test.skipIf(process.env.LIGHT_BENCH === undefined)(
  'benchmark',
  () => {
    const beats = 600;
    for (const label of ['cached', 'every frame']) {
      const { runtime } = scene(beats);
      const environment = runtime as unknown as { sampleGeneration: number };
      const start = performance.now();
      let frames = 0;
      for (let beat = 0; beat < beats; beat += 1 / 60, frames++) {
        if (label === 'every frame') environment.sampleGeneration++;
        runtime.update(beat);
      }
      console.log(`${label}: ${(((performance.now() - start) / frames) * 1000).toFixed(2)} us/frame`);
    }
  },
  600_000,
);
