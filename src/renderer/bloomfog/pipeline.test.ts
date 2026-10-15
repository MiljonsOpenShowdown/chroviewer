import { Color, PerspectiveCamera, Texture, TextureLoader, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { GAME_FOG_PARAMS } from '../fog-math';
import type { LightSegment } from './light-quads';
import { BloomfogPipeline } from './pipeline';

afterEach(() => vi.restoreAllMocks());

test('shared renderer clears fog capture and reuses unchanged fog output', () => {
  vi.spyOn(TextureLoader.prototype, 'load').mockReturnValue(new Texture());
  const pipeline = new BloomfogPipeline(128);
  let target: WebGLRenderTarget | null = null;
  const commands: string[] = [];
  const renderer = {
    autoClear: false,
    getRenderTarget: () => target,
    setRenderTarget: (next: WebGLRenderTarget | null) => {
      target = next;
    },
    getClearColor: (color: Color) => color.set(0),
    getClearAlpha: () => 0,
    setClearColor: vi.fn(),
    clear: () => commands.push('clear'),
    render: () => commands.push('render'),
  };
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const lights = [{ start: [-1, 0, -5], end: [1, 0, -5], alpha: 1, color: [1, 0, 0] }] as const;
  // Mutable coordinates are part of the runtime light segment API.
  const light: LightSegment = {
    start: [...lights[0].start] as [number, number, number],
    end: [...lights[0].end] as [number, number, number],
    color: lights[0].color,
    alpha: 1,
  };
  pipeline.render(renderer as unknown as WebGLRenderer, camera, [light]);
  expect(commands[0]).toBe('clear');
  expect(commands[1]).toBe('render');
  expect(renderer.autoClear).toBe(false);
  expect(target).toBeNull();
  const firstPasses = commands.length;
  pipeline.setFogParams({ ...GAME_FOG_PARAMS });
  pipeline.render(renderer as unknown as WebGLRenderer, camera, [light]);
  expect(commands.length).toBe(firstPasses);
  light.color = [0, 1, 0];
  pipeline.render(renderer as unknown as WebGLRenderer, camera, [light]);
  expect(commands.slice(firstPasses, firstPasses + 2)).toEqual(['clear', 'render']);
  pipeline.dispose();
});
