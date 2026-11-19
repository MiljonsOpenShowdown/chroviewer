import {
  AddEquation,
  ConstantAlphaFactor,
  CustomBlending,
  NormalBlending,
  OneFactor,
  OneMinusConstantAlphaFactor,
  type Material,
} from 'three';

type BlendState = Pick<
  Material,
  | 'transparent'
  | 'depthWrite'
  | 'blending'
  | 'blendEquation'
  | 'blendSrc'
  | 'blendDst'
  | 'blendEquationAlpha'
  | 'blendSrcAlpha'
  | 'blendDstAlpha'
  | 'blendAlpha'
>;

// Each material's own blend state, from before its first fade
const originals = new WeakMap<Material, BlendState>();

function captureBlendState(material: Material): BlendState {
  return {
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    blending: material.blending,
    blendEquation: material.blendEquation,
    blendSrc: material.blendSrc,
    blendDst: material.blendDst,
    blendEquationAlpha: material.blendEquationAlpha,
    blendSrcAlpha: material.blendSrcAlpha,
    blendDstAlpha: material.blendDstAlpha,
    blendAlpha: material.blendAlpha,
  };
}

function fadeKind(state: BlendState) {
  if (!state.transparent && state.blending === NormalBlending) return 'opaque';
  if (
    state.blending === CustomBlending &&
    state.blendSrc === OneFactor &&
    state.blendDst === OneFactor &&
    state.blendSrcAlpha === OneFactor &&
    state.blendDstAlpha === OneFactor
  ) {
    return 'additive';
  }
  return null;
}

/**
 * Fades a saber material to `opacity` (0-1) through the constant blend alpha, so no shader changes. An opaque
 * material blends as a mix with what is behind it, colour and bloom alpha alike, and stops writing depth; an
 * additive one (the glow) adds `opacity` times its colour and bloom. Other blend modes are left as they are: trails
 * fade through replayTrailOpacity instead. 1 restores the material's own blend state.
 */
export function setSaberMaterialOpacity(material: Material, opacity: number) {
  let original = originals.get(material);
  if (original === undefined) {
    if (opacity >= 1) return;
    original = captureBlendState(material);
    originals.set(material, original);
  }
  const kind = fadeKind(original);
  if (kind === null) return;
  const wasTransparent = material.transparent;
  Object.assign(material, original);
  if (opacity < 1) {
    material.blending = CustomBlending;
    material.blendAlpha = Math.max(opacity, 0);
    material.blendSrc = ConstantAlphaFactor;
    material.blendSrcAlpha = ConstantAlphaFactor;
    if (kind === 'opaque') {
      material.transparent = true;
      material.depthWrite = false;
      material.blendEquation = AddEquation;
      material.blendEquationAlpha = AddEquation;
      material.blendDst = OneMinusConstantAlphaFactor;
      material.blendDstAlpha = OneMinusConstantAlphaFactor;
    }
  }
  // Opaque and transparent materials compile to different programs
  if (material.transparent !== wasTransparent) material.needsUpdate = true;
}
