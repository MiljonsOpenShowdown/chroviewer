import {
  AddEquation,
  CanvasTexture,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  SrcAlphaFactor,
  ZeroFactor,
} from 'three';

import type { Rgb } from '../../core/colors';
import { MAIN_ONLY_LAYER } from '../mirror/planar-mirror';

const fontSize = 44;
const paddingX = 22;
const canvasHeight = 68;
const swatchSize = 22;
const swatchGap = 14;
// World height of the label in metres
const labelHeight = 0.1;

function cssColor([red, green, blue]: Rgb) {
  return `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
}

/** A camera-facing name tag (canvas texture sprite) that floats above a player's headset. */
export class PlayerNameLabel {
  readonly sprite: Sprite;

  private readonly material: SpriteMaterial;
  private texture: CanvasTexture | null = null;

  constructor() {
    this.material = new SpriteMaterial({ transparent: true, depthWrite: false });
    // Same blending as the fixed HUD: draw over the scene but keep its alpha, so the label does not bloom
    this.material.blending = CustomBlending;
    this.material.blendEquation = AddEquation;
    this.material.blendSrc = SrcAlphaFactor;
    this.material.blendDst = OneMinusSrcAlphaFactor;
    this.material.blendEquationAlpha = AddEquation;
    this.material.blendSrcAlpha = ZeroFactor;
    this.material.blendDstAlpha = OneFactor;
    this.sprite = new Sprite(this.material);
    this.sprite.layers.set(MAIN_ONLY_LAYER);
    this.sprite.renderOrder = 999;
  }

  setText(text: string, color: Rgb) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context === null) return;
    const font = `600 ${fontSize}px system-ui, sans-serif`;
    context.font = font;
    const textWidth = Math.ceil(context.measureText(text).width);
    canvas.width = paddingX * 2 + swatchSize + swatchGap + textWidth;
    canvas.height = canvasHeight;
    // Resizing the canvas resets its state
    context.font = font;
    context.fillStyle = 'rgb(0 0 0 / 0.6)';
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, canvasHeight / 2);
    context.fill();
    context.fillStyle = cssColor(color);
    context.fillRect(paddingX, (canvasHeight - swatchSize) / 2, swatchSize, swatchSize);
    context.fillStyle = '#ffffff';
    context.textBaseline = 'middle';
    context.fillText(text, paddingX + swatchSize + swatchGap, canvasHeight / 2 + 2);

    this.texture?.dispose();
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material.map = this.texture;
    this.material.needsUpdate = true;
    this.sprite.scale.set((labelHeight * canvas.width) / canvas.height, labelHeight, 1);
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.material.dispose();
  }
}
