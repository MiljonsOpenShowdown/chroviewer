import {
  Color,
  Group,
  Mesh,
  SRGBColorSpace,
  TextureLoader,
  type BufferGeometry,
  type Material,
  type ShaderMaterial,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { Rgb } from '../../core/colors';
import type { ReplaySaberModelId } from '../../core/viewer-settings';
import type { FogUniforms } from '../bloomfog/pipeline';
import { createSaberGlowMaterial } from '../materials/map-object-materials';
import { createReplaySurfaceMaterial, type ReplayDirectionalLights, type ReplaySurface } from './replay-headset';

type CustomSaberModelId = Exclude<ReplaySaberModelId, 'default'>;
type CustomSaberMaterialRole = 'surface' | 'custom-surface' | 'static-glow' | 'custom-glow';
type CustomSaberColorIndex = 0 | 1 | null;

interface CustomSaberPart {
  geometry: BufferGeometry;
  name: string;
  color: Rgb;
  colorIndex: CustomSaberColorIndex;
  role: CustomSaberMaterialRole;
}

interface CustomSaberTemplate {
  sides: [CustomSaberPart[], CustomSaberPart[]];
}

export interface CustomSaberColorBinding {
  material: ShaderMaterial;
  colorIndex: 0 | 1;
}

export interface CustomSaberInstance {
  root: Group;
  materials: ShaderMaterial[];
  colorBindings: CustomSaberColorBinding[];
}

interface CustomSaberTrailDefinition {
  base: number;
  tip: number;
  texture: string;
}

const MODEL_PATHS: Record<CustomSaberModelId, string> = {
  'ko-circles': 'ko-circles.glb',
  'ko-monkey-3': 'ko-monkey-3.glb',
  'mos-cc': 'mos-cc.glb',
  'mos-proficient': 'mos-proficient.glb',
  'mos-tourney': 'mos-tourney.glb',
  'mos-winner': 'mos-winner.glb',
};

const MODEL_TRAILS: Record<CustomSaberModelId, CustomSaberTrailDefinition> = {
  // Both Ko sabers only trail a few centimeters past the blade tip
  'ko-circles': {
    base: 1,
    tip: 1.034999967,
    texture: 'ko-circles-trail.png',
  },
  'ko-monkey-3': {
    base: 1,
    tip: 1.027999997,
    texture: 'ko-monkey-3-trail.png',
  },
  // The MOS ThinSabers share one trail
  'mos-cc': {
    base: 0.826900005,
    tip: 1.01100004,
    texture: 'mos-trail.png',
  },
  'mos-proficient': {
    base: 0.826900005,
    tip: 1.01100004,
    texture: 'mos-trail.png',
  },
  'mos-tourney': {
    base: 0.826900005,
    tip: 1.01100004,
    texture: 'mos-trail.png',
  },
  'mos-winner': {
    base: 0.826900005,
    tip: 1.01100004,
    texture: 'mos-trail.png',
  },
};

const templateCache = new Map<CustomSaberModelId, Promise<CustomSaberTemplate>>();
const textureCache = new Map<string, Promise<Texture>>();
const textureLoader = new TextureLoader();

function materialRole(name: string): CustomSaberMaterialRole {
  const role = name.split('::').at(-1);
  if (role === 'custom-surface' || role === 'static-glow' || role === 'custom-glow') return role;
  return 'surface';
}

function materialColor(material: Material): Rgb {
  const candidate = material as Material & { color?: Color };
  const color = candidate.color?.clone().convertLinearToSRGB() ?? new Color(0.8, 0.8, 0.8);
  return [color.r, color.g, color.b];
}

function colorIndex(role: CustomSaberMaterialRole, side: 0 | 1): CustomSaberColorIndex {
  return role === 'custom-glow' || role === 'custom-surface' ? side : null;
}

function readMaterial(material: Material | Material[]) {
  return Array.isArray(material) ? material[0] : material;
}

function loadTexture(fileName: string) {
  const existing = textureCache.get(fileName);
  if (existing !== undefined) return existing;
  const loading = textureLoader
    .loadAsync(`${import.meta.env.BASE_URL}sabers/textures/${fileName}`)
    .then((texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.name = fileName;
      return texture;
    })
    .catch((error: unknown) => {
      textureCache.delete(fileName);
      throw error;
    });
  textureCache.set(fileName, loading);
  return loading;
}

async function loadTemplate(model: CustomSaberModelId): Promise<CustomSaberTemplate> {
  const existing = templateCache.get(model);
  if (existing !== undefined) return existing;
  const loading = new GLTFLoader()
    .loadAsync(`${import.meta.env.BASE_URL}sabers/models/${MODEL_PATHS[model]}`)
    .then((gltf) => {
      const sides: [CustomSaberPart[], CustomSaberPart[]] = [[], []];
      const sourceMaterials = new Set<Material>();
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const side: 0 | 1 | null = object.name.startsWith('Left__') ? 0 : object.name.startsWith('Right__') ? 1 : null;
        if (side === null) return;
        const source = readMaterial(object.material);
        if (source === undefined) return;
        sourceMaterials.add(source);
        const role = materialRole(source.name);
        sides[side]?.push({
          geometry: object.geometry,
          name: source.name,
          color: materialColor(source),
          colorIndex: colorIndex(role, side),
          role,
        });
      });
      for (const material of sourceMaterials) material.dispose();
      return { sides };
    })
    .catch((error: unknown) => {
      templateCache.delete(model);
      throw error;
    });
  templateCache.set(model, loading);
  return loading;
}

function saberCoreColor([red, green, blue]: Rgb): Rgb {
  return [0.55 + red * 0.45, 0.55 + green * 0.45, 0.55 + blue * 0.45];
}

function saberSurface(color: Rgb): ReplaySurface {
  return {
    color,
    metallic: 0.42,
    smoothness: 0.5,
    specularIntensity: 0.3,
    ambientMinimalValue: 0.025,
    emissionBloomIntensity: 0.7,
  };
}

export async function createCustomSaberInstance(
  model: CustomSaberModelId,
  side: 0 | 1,
  colors: [Rgb, Rgb],
  fog: FogUniforms,
  directionalLights: ReplayDirectionalLights,
): Promise<CustomSaberInstance> {
  const template = await loadTemplate(model);
  const root = new Group();
  root.name = `${model}-${side === 0 ? 'left' : 'right'}`;
  root.rotation.y = Math.PI;
  const materials: ShaderMaterial[] = [];
  const colorBindings: CustomSaberColorBinding[] = [];
  const materialCache = new Map<string, ShaderMaterial>();

  function createMaterial(part: CustomSaberPart) {
    const materialColor = part.colorIndex === null ? part.color : colors[part.colorIndex];
    if (part.role === 'custom-glow' || part.role === 'static-glow') {
      return createSaberGlowMaterial(fog, materialColor, saberCoreColor(materialColor));
    }
    return createReplaySurfaceMaterial(fog, directionalLights, saberSurface(materialColor));
  }

  for (const part of template.sides[side]) {
    const key = `${part.name}:${part.role}:${part.colorIndex ?? 'static'}`;
    let material = materialCache.get(key);
    if (material === undefined) {
      material = createMaterial(part);
      material.name = part.name;
      materialCache.set(key, material);
      materials.push(material);
      if (part.colorIndex !== null) colorBindings.push({ material, colorIndex: part.colorIndex });
    }
    const mesh = new Mesh(part.geometry, material);
    mesh.name = part.name;
    root.add(mesh);
  }
  return { root, materials, colorBindings };
}

export function customSaberTrailPoints(model: CustomSaberModelId) {
  const { base, tip } = MODEL_TRAILS[model];
  return { base, tip };
}

export function loadCustomSaberTrailTexture(model: CustomSaberModelId) {
  return loadTexture(MODEL_TRAILS[model].texture);
}

export function isCustomSaberModel(model: ReplaySaberModelId): model is CustomSaberModelId {
  return model !== 'default';
}
