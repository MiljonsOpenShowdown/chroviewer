import { afterEach, expect, test, vi } from 'vite-plus/test';

import type { MapView } from './map-view';
import { MultiviewRendererHost } from './multiview-renderer-host';
import { BROADCAST_RENDER_PERFORMANCE } from './render-performance';

const state = vi.hoisted(() => ({ renderers: [] as { dispose: () => void }[] }));
vi.mock('three', async (importOriginal) => {
  const original = await importOriginal<typeof import('three')>();
  return {
    ...original,
    WebGLRenderer: class {
      autoClear = true;
      dispose = vi.fn();
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      setRenderTarget = vi.fn();
      setScissorTest = vi.fn();
      setClearColor = vi.fn();
      clear = vi.fn();
      constructor() {
        state.renderers.push(this);
      }
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  state.renderers.length = 0;
});

test('eight POVs share one renderer, keep their own sizes, and avoid frame-loop layout reads', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  let layoutReads = 0;
  const parent = {
    get clientWidth() {
      layoutReads++;
      return 1920;
    },
    get clientHeight() {
      layoutReads++;
      return 1080;
    },
  };
  const canvas = Object.assign(new EventTarget(), { parentElement: parent });
  const host = new MultiviewRendererHost(canvas as unknown as HTMLCanvasElement);
  const views = Array.from({ length: 8 }, (_, index) => {
    const id = String(index);
    host.setTile(id, { x: (index % 4) * 480, y: Math.floor(index / 4) * 270, width: 480, height: 270, visible: true });
    const view = { setSize: vi.fn(), renderViewport: vi.fn(), contextRestored: vi.fn() };
    host.register(id, view as unknown as MapView, { ...BROADCAST_RENDER_PERFORMANCE }, 0.65 + index * 0.01);
    return view;
  });
  const tick = (timestamp: number) => {
    const frame = frames.entries().next().value;
    if (frame === undefined) throw new Error('no scheduled frame');
    frames.delete(frame[0]);
    frame[1](timestamp);
  };
  const initialReads = layoutReads;
  tick(0);
  tick(1000 / 60);
  expect(state.renderers).toHaveLength(1);
  expect(layoutReads).toBe(initialReads);
  views.forEach((view, index) => {
    expect(view.setSize).toHaveBeenCalledTimes(1);
    expect(view.setSize).toHaveBeenCalledWith(
      Math.round(480 * (0.65 + index * 0.01)),
      Math.round(270 * (0.65 + index * 0.01)),
    );
    expect(view.renderViewport).toHaveBeenCalledTimes(2);
  });
  host.setTile('7', { x: 1440, y: 270, width: 480, height: 270, visible: false });
  tick(2000 / 60);
  expect(views[7]?.renderViewport).toHaveBeenCalledTimes(2);
  expect(views[0]?.renderViewport).toHaveBeenCalledTimes(3);
  host.dispose();
  expect(frames.size).toBe(0);
  expect(state.renderers[0]?.dispose).toHaveBeenCalledTimes(1);
});
