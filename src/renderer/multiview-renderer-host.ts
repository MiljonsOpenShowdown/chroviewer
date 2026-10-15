import { Color, WebGLRenderer } from 'three';

import type { MapView } from './map-view';
import { nextRenderDeadline } from './render-frame-pacing';
import type { RenderPerformanceOptions } from './render-performance';
import { clampRenderScale } from './render-scale';

export interface MultiviewTile {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

interface Entry {
  view: MapView;
  tile: MultiviewTile;
  renderScale: number;
  performance: RenderPerformanceOptions;
  sizedWidth: number;
  sizedHeight: number;
}

export interface SharedViewerLifecycle {
  setPerformance(performance: RenderPerformanceOptions): void;
  setRenderScale(scale: number): void;
}

export function multiviewFrameRate(entries: Iterable<{ performance: RenderPerformanceOptions }>) {
  let rate: number | null = null;
  for (const entry of entries) {
    rate = Math.min(rate ?? entry.performance.maxFps, entry.performance.maxFps);
  }
  return Math.max(1, rate ?? 1);
}

export class MultiviewRendererHost {
  private readonly renderer: WebGLRenderer;
  private readonly entries = new Map<string, Entry>();
  private readonly pendingTiles = new Map<string, MultiviewTile>();
  private readonly clearColor = new Color(0x000000);
  private resizeObserver: ResizeObserver | null = null;
  private frameHandle: number | null = null;
  private contextLost = false;
  private nextFrameAt = 0;
  private width = -1;
  private height = -1;
  private readonly visibleEntries: Entry[] = [];
  private entriesChanged = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      depth: false,
      // The canvas remains transparent outside the scissored replay tiles.
      // Tile output itself is opaque, so no premultiplication ambiguity is
      // allowed to alter the post-bloom colors Chromium receives.
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.scheduleFrame();
  }

  register(
    id: string,
    view: MapView,
    performance: RenderPerformanceOptions,
    renderScale: number,
  ): SharedViewerLifecycle {
    const entry: Entry = {
      view,
      tile: this.pendingTiles.get(id) ?? { x: 0, y: 0, width: 1, height: 1, visible: false },
      renderScale: clampRenderScale(renderScale),
      performance: { ...performance },
      sizedWidth: -1,
      sizedHeight: -1,
    };
    this.entries.set(id, entry);
    this.entriesChanged = true;
    this.nextFrameAt = 0;
    return {
      setPerformance: (next) => {
        entry.performance = { ...next };
        view.setRenderPerformance(next);
        this.nextFrameAt = 0;
      },
      setRenderScale: (scale) => {
        const next = clampRenderScale(scale);
        if (next === entry.renderScale) return;
        entry.renderScale = next;
        entry.sizedWidth = -1;
      },
    };
  }

  unregister(id: string, view: MapView) {
    const entry = this.entries.get(id);
    if (entry?.view === view) {
      this.entries.delete(id);
      this.entriesChanged = true;
      this.nextFrameAt = 0;
    }
  }

  setTile(id: string, tile: MultiviewTile) {
    const normalized = {
      x: Math.round(tile.x),
      y: Math.round(tile.y),
      width: Math.max(1, Math.round(tile.width)),
      height: Math.max(1, Math.round(tile.height)),
      visible: tile.visible,
    };
    this.pendingTiles.set(id, normalized);
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    const previous = entry.tile;
    if (
      previous.x === normalized.x &&
      previous.y === normalized.y &&
      previous.width === normalized.width &&
      previous.height === normalized.height &&
      previous.visible === normalized.visible
    )
      return;
    entry.tile = normalized;
    this.entriesChanged = true;
    this.nextFrameAt = 0;
  }

  retainTiles(ids: Iterable<string>) {
    const retained = new Set(ids);
    for (const id of this.pendingTiles.keys()) {
      if (!retained.has(id)) this.pendingTiles.delete(id);
    }
  }

  private readonly resize = () => {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, Math.round(parent?.clientWidth ?? innerWidth));
    const height = Math.max(1, Math.round(parent?.clientHeight ?? innerHeight));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
  };

  private readonly frame = (timestamp: number) => {
    this.frameHandle = null;
    if (this.contextLost || document.hidden) return;
    this.scheduleFrame();
    if (this.entriesChanged) {
      this.visibleEntries.length = 0;
      for (const entry of this.entries.values()) {
        if (entry.tile.visible) this.visibleEntries.push(entry);
      }
      this.entriesChanged = false;
    }
    const visibleEntries = this.visibleEntries;
    // A shared canvas renders every visible tile as one frame. Respect the
    // strictest player cap so one override cannot silently multiply all POV work.
    const maxFps = multiviewFrameRate(visibleEntries);
    const nextFrameAt = nextRenderDeadline(timestamp, this.nextFrameAt, maxFps);
    if (nextFrameAt === null) return;
    this.nextFrameAt = nextFrameAt;
    this.renderer.setRenderTarget(null);
    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(this.clearColor, 0);
    this.renderer.clear(true, true, true);
    for (const entry of visibleEntries) {
      const tile = entry.tile;
      if (
        tile.width <= 0 ||
        tile.height <= 0 ||
        tile.x >= this.width ||
        tile.y >= this.height ||
        tile.x + tile.width <= 0 ||
        tile.y + tile.height <= 0
      )
        continue;
      const renderWidth = Math.max(1, Math.round((entry.performance.outputWidth ?? tile.width) * entry.renderScale));
      const renderHeight = Math.max(1, Math.round((entry.performance.outputHeight ?? tile.height) * entry.renderScale));
      if (renderWidth !== entry.sizedWidth || renderHeight !== entry.sizedHeight) {
        entry.sizedWidth = renderWidth;
        entry.sizedHeight = renderHeight;
        entry.view.setSize(renderWidth, renderHeight);
      }
      entry.view.renderViewport(this.renderer, {
        x: tile.x,
        y: this.height - tile.y - tile.height,
        width: tile.width,
        height: tile.height,
        renderWidth,
        renderHeight,
      });
    }
  };

  private scheduleFrame() {
    if (this.frameHandle !== null || this.contextLost || document.hidden) return;
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  };

  private readonly handleContextRestored = () => {
    this.contextLost = false;
    this.nextFrameAt = 0;
    for (const entry of this.entries.values()) entry.view.contextRestored();
    this.scheduleFrame();
  };

  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    } else {
      this.nextFrameAt = 0;
      this.resize();
      this.scheduleFrame();
    }
  };

  dispose() {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.entries.clear();
    this.visibleEntries.length = 0;
    this.pendingTiles.clear();
    this.renderer.dispose();
  }
}
