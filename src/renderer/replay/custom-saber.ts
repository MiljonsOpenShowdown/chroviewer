import {
  Color,
  Group,
  Mesh,
  NoColorSpace,
  RepeatWrapping,
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
import type { MaterialTexture } from '../materials/shared';
import { createCg5SaberGlowMaterial } from './cg5-saber-materials';
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
  texture?: MaterialTexture;
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
  beatkhana: 'beatkhana.glb',
  cg5: 'cg5.glb',
  'cube-community-new': 'cube-community-new.glb',
  'cube-community-v1': 'cube-community-v1.glb',
  euc: 'euc.glb',
};

const MODEL_TRAILS: Record<CustomSaberModelId, CustomSaberTrailDefinition> = {
  beatkhana: {
    base: 0.504500031,
    tip: 1.004500031,
    texture: 'beatkhana-trail.png',
  },
  cg5: {
    base: 0.9045000076293945,
    tip: 1.0045000314712524,
    texture: 'cg5-trail.png',
  },
  'cube-community-new': {
    base: 0.8,
    tip: 1,
    texture: 'cube-community-new-trail.png',
  },
  'cube-community-v1': {
    base: 0.23,
    tip: 1.0308,
    texture: 'cube-community-v1-trail.png',
  },
  euc: {
    base: 0.504500031,
    tip: 1.004500031,
    texture: 'euc-trail.png',
  },
};

const templateCache = new Map<CustomSaberModelId, Promise<CustomSaberTemplate>>();
const textureCache = new Map<string, Promise<Texture>>();
const textureLoader = new TextureLoader();

function materialBaseName(name: string) {
  return name.split('::')[0] ?? name;
}

function materialRole(model: CustomSaberModelId, name: string): CustomSaberMaterialRole {
  const baseName = materialBaseName(name);
  if (model === 'cube-community-new' && (baseName === 'LeftSaber' || baseName === 'RightSaber')) {
    return 'custom-glow';
  }
  const role = name.split('::').at(-1);
  if (role === 'custom-surface' || role === 'static-glow' || role === 'custom-glow') return role;
  return 'surface';
}

function materialColor(model: CustomSaberModelId, material: Material): Rgb {
  if (model === 'cube-community-new' && materialBaseName(material.name) === 'LogoCut') {
    return [0.018, 0.006, 0.028];
  }
  const candidate = material as Material & { color?: Color };
  const color = candidate.color?.clone().convertLinearToSRGB() ?? new Color(0.8, 0.8, 0.8);
  return [color.r, color.g, color.b];
}

function colorIndex(
  model: CustomSaberModelId,
  name: string,
  role: CustomSaberMaterialRole,
  side: 0 | 1,
): CustomSaberColorIndex {
  const baseName = materialBaseName(name);
  if (model === 'cube-community-new' && baseName === 'LeftSaber') return 0;
  if (model === 'cube-community-new' && baseName === 'RightSaber') return 1;
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
      // CG5's fire shader reads masks and displacement, not sRGB colors.
      texture.colorSpace = fileName.startsWith('cg5-') ? NoColorSpace : SRGBColorSpace;
      if (fileName === 'cg5-trail-displacement.png') {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
      }
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
  const loading = Promise.all([
    new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}sabers/models/${MODEL_PATHS[model]}`),
    model === 'cube-community-new' ? loadTexture('cube-community-new-handle.png') : Promise.resolve(undefined),
  ])
    .then(([gltf, cubeHandleTexture]) => {
      const sides: [CustomSaberPart[], CustomSaberPart[]] = [[], []];
      const sourceMaterials = new Set<Material>();
      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const side: 0 | 1 | null = object.name.startsWith('Left__') ? 0 : object.name.startsWith('Right__') ? 1 : null;
        if (side === null) return;
        const source = readMaterial(object.material);
        if (source === undefined) return;
        sourceMaterials.add(source);
        const baseName = materialBaseName(source.name);
        // Unity renders this capture plane into the V1 trail material. The
        // native trail texture is rendered directly below, so retaining the
        // plane would leave an opaque rectangle around the saber.
        if (model === 'cube-community-v1' && baseName === 'Animated Trail Mat') return;
        const role = materialRole(model, source.name);
        const texture =
          model === 'cube-community-new' && (baseName === 'LeftHandle' || baseName === 'RightHandle')
            ? cubeHandleTexture
            : undefined;
        sides[side]?.push({
          geometry: object.geometry,
          name: source.name,
          color: materialColor(model, source),
          colorIndex: colorIndex(model, source.name, role, side),
          role,
          texture: texture === undefined ? undefined : { texture, scale: [1, 1], offset: [0, 0] },
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

function saberSurface(color: Rgb, luminous: boolean, texture?: MaterialTexture): ReplaySurface {
  return {
    color,
    metallic: luminous ? 0.12 : 0.42,
    smoothness: luminous ? 0.72 : 0.5,
    specularIntensity: luminous ? 0.25 : 0.3,
    ambientMinimalValue: luminous ? 0.12 : 0.025,
    diffuse: texture,
    emission: luminous ? texture : undefined,
    emissionColor: color,
    emissionBrightness: luminous && texture !== undefined ? 1.45 : 0,
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
    if (model === 'cg5' && (part.role === 'custom-glow' || materialBaseName(part.name) === 'Hilt')) {
      return createCg5SaberGlowMaterial(fog, materialColor, part.role === 'custom-glow' ? 0.8 : 0);
    }
    if ((part.role === 'custom-glow' || part.role === 'static-glow') && part.texture === undefined) {
      return createSaberGlowMaterial(fog, materialColor, saberCoreColor(materialColor));
    }
    return createReplaySurfaceMaterial(
      fog,
      directionalLights,
      saberSurface(materialColor, part.role === 'custom-glow' || part.role === 'static-glow', part.texture),
    );
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

export function loadCustomSaberTrailDisplacementTexture(model: CustomSaberModelId) {
  return model === 'cg5' ? loadTexture('cg5-trail-displacement.png') : Promise.resolve(undefined);
}

export function isCustomSaberModel(model: ReplaySaberModelId): model is CustomSaberModelId {
  return model !== 'default';
}
