import { readFileSync } from 'node:fs';

import { Box3, Color, SRGBColorSpace, Texture, TextureLoader, Vector2 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import type { Rgb } from '../../core/colors';
import type { FogUniforms } from '../bloomfog/pipeline';
import { shaderColorUniform } from '../materials/shared';
import {
  applyCustomSaberBrightness,
  createCustomSaberInstance,
  customSaberTrailPoints,
  loadCustomSaberTrailTexture,
} from './custom-saber';

afterEach(() => vi.restoreAllMocks());

test('loads the real Ko-Circles mesh with independent player colors, opaque handles and aligned native trails', async () => {
  const bytes = readFileSync(new URL('../../../public/sabers/models/ko-circles.glb', import.meta.url));
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
  const [left, right, otherPlayer, trail] = await Promise.all([
    createCustomSaberInstance('ko-circles', 0, colors, fog, lights),
    createCustomSaberInstance('ko-circles', 1, colors, fog, lights),
    createCustomSaberInstance(
      'ko-circles',
      0,
      [
        [1, 0, 0],
        [0, 0, 1],
      ],
      fog,
      lights,
    ),
    loadCustomSaberTrailTexture('ko-circles'),
  ]);

  expect(loader).toHaveBeenCalledOnce();
  expect(loader).toHaveBeenCalledWith(expect.stringContaining('sabers/models/ko-circles.glb'));
  expect(left.root.children).toHaveLength(3);
  expect(right.root.children).toHaveLength(3);
  for (const [side, instance] of [left, right].entries()) {
    expect(instance.colorBindings).toHaveLength(2);
    for (const binding of instance.colorBindings) {
      expect(binding.colorIndex).toBe(side);
      expect(shaderColorUniform(binding.material, '_Color')).toEqual(
        new Color().setRGB(...colors[side as 0 | 1]).convertSRGBToLinear(),
      );
    }
    const handle = instance.materials.find((material) => material.name === 'Handle_mat::surface');
    if (handle === undefined) throw new Error('Ko-Circles is missing its static handle');
    expect(handle.transparent).toBe(false);
    expect(handle.depthWrite).toBe(true);
    const bounds = new Box3().setFromObject(instance.root);
    const points = customSaberTrailPoints('ko-circles');
    expect(-points.base).toBeGreaterThanOrEqual(bounds.min.z - 0.01);
    expect(-points.tip).toBeLessThan(bounds.min.z);
  }
  const ownGlow = left.colorBindings[0]?.material;
  const otherGlow = otherPlayer.colorBindings[0]?.material;
  expect(ownGlow).not.toBe(otherGlow);
  if (ownGlow !== undefined && otherGlow !== undefined) {
    shaderColorUniform(ownGlow, '_Color')?.setRGB(0, 1, 0);
    expect(shaderColorUniform(otherGlow, '_Color')).toEqual(new Color(1, 0, 0));
  }
  expect(trail.colorSpace).toBe(SRGBColorSpace);
  for (const instance of [left, right, otherPlayer]) {
    for (const material of instance.materials) material.dispose();
  }
});

test('renders the MOS handle as dark metal and its "M" plate as a flat glow', async () => {
  const bytes = readFileSync(new URL('../../../public/sabers/models/mos-tourney.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(gltf);
  const fog: FogUniforms = {
    _BloomPrePassTexture: { value: new Texture() },
    _CustomFogTextureToScreenRatio: { value: new Vector2(1, 1) },
    _CustomFogOffset: { value: 0 },
    _CustomFogAttenuation: { value: 0 },
    _CustomFogHeightFogStartY: { value: 0 },
    _CustomFogHeightFogHeight: { value: 0 },
  };
  const lights = { directions: [], colors: [], positions: [], radii: [] };
  const instance = await createCustomSaberInstance(
    'mos-tourney',
    0,
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
    fog,
    lights,
  );

  const handle = instance.materials.find((material) => material.name === 'Metallic::surface');
  const logo = instance.materials.find((material) => material.name === 'geen::static-glow');
  if (handle === undefined || logo === undefined) throw new Error('MOS Tourney is missing its handle or logo');
  const handleColor = shaderColorUniform(handle, '_Color');
  expect(handleColor?.r).toBeLessThan(0.05);
  expect(logo.uniforms._Brightness).toBeDefined();
  expect(logo.uniforms._CoreColor).toBeUndefined();
  expect(logo.transparent).toBe(false);

  const blade = instance.materials.find((material) => material.name === 'CC 0.3::custom-glow');
  if (blade === undefined) throw new Error('MOS Tourney is missing its blade');
  const bladeMultiplier = blade.uniforms._ColorMultiplier?.value as number;
  const logoBrightness = logo.uniforms._Brightness?.value as number;
  applyCustomSaberBrightness(instance.brightnessBindings, 0.5);
  expect(blade.uniforms._ColorMultiplier?.value).toBeCloseTo(bladeMultiplier * 0.5);
  expect(logo.uniforms._Brightness?.value).toBeCloseTo(logoBrightness * 0.5);
  applyCustomSaberBrightness(instance.brightnessBindings, 2);
  expect(blade.uniforms._ColorMultiplier?.value).toBeCloseTo(bladeMultiplier * 2);
  expect(blade.uniforms._BloomAlpha?.value).toBeLessThanOrEqual(1);
  for (const material of instance.materials) material.dispose();
});
