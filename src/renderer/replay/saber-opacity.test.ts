import {
  ConstantAlphaFactor,
  CustomBlending,
  NormalBlending,
  OneFactor,
  OneMinusConstantAlphaFactor,
  ShaderMaterial,
} from 'three';
import { expect, test } from 'vite-plus/test';

import { additive } from '../materials/shared';
import { setSaberMaterialOpacity } from './saber-opacity';

test('fades an opaque material as a mix with what is behind it, and restores it at 1', () => {
  const material = new ShaderMaterial();
  setSaberMaterialOpacity(material, 0.4);
  expect(material).toMatchObject({
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendAlpha: 0.4,
    blendSrc: ConstantAlphaFactor,
    blendDst: OneMinusConstantAlphaFactor,
    blendSrcAlpha: ConstantAlphaFactor,
    blendDstAlpha: OneMinusConstantAlphaFactor,
  });
  setSaberMaterialOpacity(material, 1);
  expect(material).toMatchObject({ transparent: false, depthWrite: true, blending: NormalBlending });
});

test('scales an additive material without changing what it adds to', () => {
  const material = new ShaderMaterial({ ...additive, depthWrite: false });
  setSaberMaterialOpacity(material, 0.5);
  expect(material).toMatchObject({
    transparent: true,
    blendAlpha: 0.5,
    blendSrc: ConstantAlphaFactor,
    blendDst: OneFactor,
    blendSrcAlpha: ConstantAlphaFactor,
    blendDstAlpha: OneFactor,
  });
  setSaberMaterialOpacity(material, 0.2);
  expect(material.blendAlpha).toBe(0.2);
  setSaberMaterialOpacity(material, 1);
  expect(material).toMatchObject({ blendSrc: OneFactor, blendSrcAlpha: OneFactor });
});

test('leaves other blend modes alone', () => {
  const material = new ShaderMaterial({ transparent: true });
  setSaberMaterialOpacity(material, 0.5);
  expect(material).toMatchObject({ transparent: true, blending: NormalBlending, blendAlpha: 0 });
});
