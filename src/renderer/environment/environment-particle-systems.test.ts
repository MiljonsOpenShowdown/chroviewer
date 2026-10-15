import { readFileSync } from 'node:fs';

import { Group, Texture, Vector2, type BufferGeometry, type Material } from 'three';
import { expect, test } from 'vite-plus/test';

import { GAME_FOG_PARAMS } from '../fog-math';
import { buildEnvironmentParticleSystems } from './environment-particle-systems';
import type { EnvironmentMaterialContext } from './materials/material-context';
import type { EnvironmentData } from './types';

function buildParticles(environmentId: string) {
  const data = JSON.parse(
    readFileSync(new URL(`../../../public/environments/${environmentId}.json`, import.meta.url), 'utf8'),
  ) as EnvironmentData;
  const systems = data.particleSystems ?? [];
  const texture = new Texture();
  const root = new Group();
  const geometries = new Map<string, BufferGeometry>();
  const materials = new Set<Material>();
  const context: EnvironmentMaterialContext = {
    fog: {
      _BloomPrePassTexture: { value: texture },
      _CustomFogTextureToScreenRatio: { value: new Vector2(1, 1) },
      _CustomFogOffset: { value: GAME_FOG_PARAMS.offset },
      _CustomFogAttenuation: { value: GAME_FOG_PARAMS.attenuation },
      _CustomFogHeightFogStartY: { value: GAME_FOG_PARAMS.startY },
      _CustomFogHeightFogHeight: { value: GAME_FOG_PARAMS.height },
    },
    reflectionTexture: { value: texture },
    directionalLights: {
      directions: { value: [] },
      colors: { value: [] },
      positions: { value: [] },
      radii: { value: [] },
    },
    textures: new Map(systems.map((system) => [system.texture, texture])),
  };
  buildEnvironmentParticleSystems(systems, context, root, geometries, materials);
  return {
    root,
    geometries,
    materials,
    dispose() {
      for (const geometry of geometries.values()) geometry.dispose();
      for (const material of materials) material.dispose();
      texture.dispose();
    },
  };
}

test('Lattice omits the camera-obscuring smoke while retaining its dust particles', ({ onTestFinished }) => {
  const particles = buildParticles('LatticeEnvironment');
  onTestFinished(() => particles.dispose());
  expect(particles.root.children.map((node) => node.name)).toEqual(['DustPS']);
  expect(particles.root.getObjectByName('DustPS:particles')).toHaveProperty('geometry.attributes.position.count', 1000);
  expect(particles.geometries.size).toBe(1);
  expect(particles.materials.size).toBe(1);
});

test('BTS retains its ambient star particles', ({ onTestFinished }) => {
  const particles = buildParticles('BTSEnvironment');
  onTestFinished(() => particles.dispose());
  expect(particles.root.children.map((node) => node.name)).toEqual(['StarsPS']);
  expect(particles.geometries.size).toBe(1);
  expect(particles.materials.size).toBe(1);
});
