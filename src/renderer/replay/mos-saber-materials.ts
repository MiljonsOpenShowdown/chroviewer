import { ShaderMaterial } from 'three';

import type { Rgb } from '../../core/colors';
import type { FogUniforms } from '../bloomfog/pipeline';
import { linearColor, materialFogUniforms } from '../materials/shared';
import { ACES_CHUNK, FOG_CHUNK, OBJECT_VERT } from '../shaders/chunks';

// Flat, opaque glow: keeps the logo's own color instead of the default
// saber glow's additive blend toward a white core.
const MOS_LOGO_FRAG = /* glsl */ `
uniform vec3 _Color;
uniform float _Brightness;
uniform float _Glow;
uniform float _FogStartOffset;
uniform float _FogScale;
varying vec3 vWorldPos;
varying vec4 vScreenPos;
${ACES_CHUNK}
${FOG_CHUNK}
void main() {
  gl_FragColor = applyChroFog(vec4(chroToneMap(_Color * _Brightness), _Glow), vScreenPos, vWorldPos, _FogStartOffset, _FogScale);
  #include <colorspace_fragment>
}
`;

export function createMosLogoMaterial(fog: FogUniforms, color: Rgb, brightness: number, glow: number) {
  return new ShaderMaterial({
    vertexShader: OBJECT_VERT,
    fragmentShader: MOS_LOGO_FRAG,
    uniforms: {
      ...materialFogUniforms(fog),
      _Color: { value: linearColor(color) },
      _Brightness: { value: brightness },
      _Glow: { value: glow },
    },
  });
}
