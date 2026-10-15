import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  type Texture,
} from 'three';

import type { Rgb } from '../../core/colors';
import type { FogUniforms } from '../bloomfog/pipeline';
import { linearColor, materialFogUniforms } from '../materials/shared';
import { ACES_CHUNK, FOG_CHUNK, OBJECT_VERT } from '../shaders/chunks';
import { SABER_TRAIL_VERT } from '../shaders/map-object-shaders';

const CG5_GLOW_FRAG = /* glsl */ `
uniform vec3 _Color;
uniform float _Glow;
uniform float _FogStartOffset;
uniform float _FogScale;
varying vec3 vWorldPos;
varying vec4 vScreenPos;
${ACES_CHUNK}
${FOG_CHUNK}
void main() {
  gl_FragColor = applyChroFog(vec4(chroToneMap(_Color), _Glow), vScreenPos, vWorldPos, _FogStartOffset, _FogScale);
  #include <colorspace_fragment>
}
`;

// Port of Ikeiwa's BeatSaber/Fire Trail (MIT); see public/sabers/cg5-trail-shader-LICENSE.txt.
const CG5_TRAIL_FRAG = /* glsl */ `
uniform vec3 _Color;
uniform sampler2D _TrailTexture;
uniform sampler2D _DisplaceTexture;
uniform float _Time;
uniform float _DispPower;
uniform float _DispSpeed;
uniform float _Glow;
varying float vTrailAlpha;
varying vec2 vTrailUv;
void main() {
  vec2 displacement = vec2(
    texture2D(_DisplaceTexture, vTrailUv + vec2(0.0, _Time * _DispSpeed)).r * 2.0,
    texture2D(_DisplaceTexture, vTrailUv + vec2(0.0, _Time * 2.0 * _DispSpeed)).g
  );
  float displacedMask = texture2D(_TrailTexture, vTrailUv + displacement * _DispPower).r;
  float fadeMask = texture2D(_TrailTexture, vTrailUv).r;
  float coverage = clamp(displacedMask * fadeMask * vTrailAlpha * _Glow, 0.0, 1.0);
  // ChroViewer stores bloom in scene alpha; blend it using the same coverage
  // as RGB so the glow follows the displaced mask.
  gl_FragColor = vec4(_Color, coverage);
  #include <colorspace_fragment>
}
`;

export function createCg5SaberGlowMaterial(fog: FogUniforms, color: Rgb, glow: number) {
  return new ShaderMaterial({
    vertexShader: OBJECT_VERT,
    fragmentShader: CG5_GLOW_FRAG,
    uniforms: {
      ...materialFogUniforms(fog),
      _Color: { value: linearColor(color) },
      _Glow: { value: glow },
    },
  });
}

export function createCg5SaberTrailMaterial(color: Rgb, trail: Texture, displacement: Texture) {
  return new ShaderMaterial({
    vertexShader: SABER_TRAIL_VERT,
    fragmentShader: CG5_TRAIL_FRAG,
    uniforms: {
      _Color: { value: linearColor(color) },
      _TrailTexture: { value: trail },
      _DisplaceTexture: { value: displacement },
      _Time: { value: 0 },
      _DispPower: { value: 0.2 },
      _DispSpeed: { value: -1 },
      _Glow: { value: 12 },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: SrcAlphaFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
  });
}
