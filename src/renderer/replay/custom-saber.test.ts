import { readFileSync } from 'node:fs';

import { Box3, Color, NoColorSpace, RepeatWrapping, Texture, TextureLoader, Vector2 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import type { Rgb } from '../../core/colors';
import type { FogUniforms } from '../bloomfog/pipeline';
import { shaderColorUniform } from '../materials/shared';
import {
  createCustomSaberInstance,
  customSaberTrailPoints,
  loadCustomSaberTrailDisplacementTexture,
  loadCustomSaberTrailTexture,
} from './custom-saber';

afterEach(() => vi.restoreAllMocks());

test('loads the real CG5 mesh with independent player colors, opaque hilts and aligned native trails', async () => {
  const bytes = readFileSync(new URL('../../../public/sabers/models/cg5.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  const loader = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(gltf);
  vi.spyOn(TextureLoader.prototype, 'loadAsync').mockImplementation(async () => new Texture());
  const fog: FogUniforms = {
    _BloomPrePassTexture: { value: new Texture() },
    _CustomFogTextureToScreenRatio: { value: new Vector2(1, 1) },
    _CustomFogOffset: { value: 0 },
    _CustomFogAttenuation: { value: 0 },
    _CustomFogHeightFogStartY: { value: 0 },
    _CustomFogHeightFogHeight: { value: 0 },
  };
  const lights = { directions: [], colors: [], positions: [], radii: [] };
  const colors: [Rgb, Rgb] = [
    [0.1, 0.9, 0.2],
    [0.9, 0.1, 0.8],
  ];
  const [left, right, otherPlayer, trail, displacement] = await Promise.all([
    createCustomSaberInstance('cg5', 0, colors, fog, lights),
    createCustomSaberInstance('cg5', 1, colors, fog, lights),
    createCustomSaberInstance(
      'cg5',
      0,
      [
        [1, 0, 0],
        [0, 0, 1],
      ],
      fog,
      lights,
    ),
    loadCustomSaberTrailTexture('cg5'),
    loadCustomSaberTrailDisplacementTexture('cg5'),
  ]);

  expect(loader).toHaveBeenCalledOnce();
  expect(loader).toHaveBeenCalledWith(expect.stringContaining('sabers/models/cg5.glb'));
  expect(left.root.children).toHaveLength(10);
  expect(right.root.children).toHaveLength(10);
  for (const [side, instance] of [left, right].entries()) {
    expect(instance.colorBindings).toHaveLength(2);
    for (const binding of instance.colorBindings) {
      expect(binding.colorIndex).toBe(side);
      expect(shaderColorUniform(binding.material, '_Color')).toEqual(
        new Color().setRGB(...colors[side as 0 | 1]).convertSRGBToLinear(),
      );
    }
    const hilt = instance.materials.find((material) => material.name === 'Hilt::surface');
    if (hilt === undefined) throw new Error('CG5 is missing its static hilt');
    expect(hilt?.transparent).toBe(false);
    expect(hilt?.depthWrite).toBe(true);
    expect(shaderColorUniform(hilt, '_Color')).toEqual(new Color(0, 0, 0));
    const bounds = new Box3().setFromObject(instance.root);
    const points = customSaberTrailPoints('cg5');
    expect(bounds.min.z).toBeCloseTo(-points.tip, 2);
    expect(bounds.max.z).toBeGreaterThan(0.2);
    expect(-points.base).toBeGreaterThan(bounds.min.z);
    expect(-points.base).toBeLessThan(bounds.max.z);
  }
  const ownGlow = left.colorBindings[0]?.material;
  const otherGlow = otherPlayer.colorBindings[0]?.material;
  expect(ownGlow).not.toBe(otherGlow);
  if (ownGlow !== undefined && otherGlow !== undefined) {
    shaderColorUniform(ownGlow, '_Color')?.setRGB(0, 1, 0);
    expect(shaderColorUniform(otherGlow, '_Color')).toEqual(new Color(1, 0, 0));
  }
  expect(trail.colorSpace).toBe(NoColorSpace);
  expect(displacement?.colorSpace).toBe(NoColorSpace);
  expect(displacement?.wrapS).toBe(RepeatWrapping);
  expect(displacement?.wrapT).toBe(RepeatWrapping);
  for (const instance of [left, right, otherPlayer]) {
    for (const material of instance.materials) material.dispose();
  }
});
