import {
  ClampToEdgeWrapping,
  CubeTextureLoader,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  Vector4,
  type CubeTexture,
  type Texture,
} from 'three';

import type { EnvironmentBakedReflectionProbe } from './environment-runtime';
import { loadEnvironmentData } from './environment-worker-client';
import { PARAMETRIC_FAKE_GLOW_TEXTURE, PARAMETRIC_SLICE_TEXTURE } from './materials/light-environment-material';
import type { EnvironmentData } from './types';

export interface LoadedEnvironmentAssets {
  data: EnvironmentData;
  textures: ReadonlyMap<string, Texture>;
  reflectionProbe?: CubeTexture;
  bakedReflectionProbe?: EnvironmentBakedReflectionProbe;
  dispose: () => void;
}

type EnvironmentDataLoader = (id: string, signal?: AbortSignal) => Promise<EnvironmentData>;

interface CachedEnvironmentAssets {
  refs: number;
  assets?: LoadedEnvironmentAssets;
  promise: Promise<LoadedEnvironmentAssets>;
}

const environmentAssetsCache = new Map<string, CachedEnvironmentAssets>();

function materialTextureAssets(data: EnvironmentData) {
  return [
    ...Object.values(data.materials).flatMap((material) =>
      Object.values(material.textures ?? {}).map((texture) => texture.asset),
    ),
    ...(data.particleSystems ?? []).map((system) => system.texture),
  ];
}

function linearTextureAssets(data: EnvironmentData) {
  const linearAssets = new Set(
    Object.values(data.materials).flatMap((material) => {
      const textures = material.textures;
      if (textures === undefined) return [];
      const assets = [
        '_NormalTex',
        '_MaskTex',
        '_Mask2Tex',
        '_DisplacementTex',
        '_NoiseTex',
        '_DistortTex',
        '_MetalSmoothnessTex',
        '_DirtDetailTex',
        '_EmissionTex',
        '_EmissionMask',
        '_SecondaryEmissionMask',
        '_NormalTexture',
      ].flatMap((property) => textures[property]?.asset ?? []);
      const main = textures._MainTex;
      if (
        main !== undefined &&
        material.keywords.includes('_ALPHACHANNEL_RED') &&
        !material.keywords.includes('TEXTURE_COLOR')
      ) {
        assets.push(main.asset);
      }
      return assets;
    }),
  );
  for (const system of data.particleSystems ?? []) {
    if (system.alphaChannelRed) linearAssets.add(system.texture);
  }
  return linearAssets;
}

async function loadEnvironmentAssetsUncached(
  id: string,
  signal?: AbortSignal,
  loadData: EnvironmentDataLoader = loadEnvironmentData,
): Promise<LoadedEnvironmentAssets> {
  const data = await loadData(id, signal);

  const assets = new Set(materialTextureAssets(data));
  const clampedAssets = new Set(
    Object.values(data.materials).flatMap((material) =>
      material.shader === 'ChroMapper/Parametric Slice Billboard'
        ? (material.textures?._MainTex?.asset ?? PARAMETRIC_SLICE_TEXTURE)
        : [],
    ),
  );
  for (const system of data.particleSystems ?? []) clampedAssets.add(system.texture);
  if (Object.values(data.materials).some((material) => material.shader === 'ChroMapper/Parametric Box Fake Glow')) {
    assets.add(PARAMETRIC_FAKE_GLOW_TEXTURE);
  }
  if (Object.values(data.materials).some((material) => material.shader === 'ChroMapper/Parametric Slice Billboard')) {
    assets.add(PARAMETRIC_SLICE_TEXTURE);
  }

  const linearAssets = linearTextureAssets(data);
  const textureLoader = new TextureLoader();
  const textures = new Map<string, Texture>();
  let reflectionProbe: CubeTexture | undefined;
  let bakedReflectionProbe: EnvironmentBakedReflectionProbe | undefined;
  function dispose() {
    for (const texture of textures.values()) texture.dispose();
    reflectionProbe?.dispose();
    for (const texture of bakedReflectionProbe?.textures ?? []) texture.dispose();
  }

  try {
    let textureFailure: { cause: unknown } | undefined;
    await Promise.all(
      [...assets].map(async (asset) => {
        try {
          const texture = await textureLoader.loadAsync(`${import.meta.env.BASE_URL}environments/${asset}`);
          texture.colorSpace = linearAssets.has(asset) ? NoColorSpace : SRGBColorSpace;
          texture.wrapS = clampedAssets.has(asset) ? ClampToEdgeWrapping : RepeatWrapping;
          texture.wrapT = clampedAssets.has(asset) ? ClampToEdgeWrapping : RepeatWrapping;
          textures.set(asset, texture);
        } catch (cause) {
          textureFailure ??= { cause };
        }
      }),
    );
    if (textureFailure !== undefined) throw textureFailure.cause;
    signal?.throwIfAborted();
    reflectionProbe =
      data.reflectionProbe === undefined
        ? undefined
        : await new CubeTextureLoader().loadAsync(
            data.reflectionProbe.map((asset) => `${import.meta.env.BASE_URL}environments/${asset}`),
          );
    if (reflectionProbe !== undefined) reflectionProbe.colorSpace = SRGBColorSpace;
    if (data.bakedReflectionProbe !== undefined) {
      const [first, second] = data.bakedReflectionProbe.textures;
      const textures: [CubeTexture, CubeTexture] = await Promise.all([
        new CubeTextureLoader().loadAsync(first.map((asset) => `${import.meta.env.BASE_URL}environments/${asset}`)),
        new CubeTextureLoader().loadAsync(second.map((asset) => `${import.meta.env.BASE_URL}environments/${asset}`)),
      ]);
      for (const texture of textures) texture.colorSpace = SRGBColorSpace;
      const position = new Vector3(...data.bakedReflectionProbe.position);
      const halfSize = new Vector3(...data.bakedReflectionProbe.size).multiplyScalar(0.5);
      bakedReflectionProbe = {
        textures,
        position,
        boxMin: position.clone().sub(halfSize),
        boxMax: position.clone().add(halfSize),
        lightColors: Array.from({ length: 6 }, () => new Vector4()),
        lights: data.bakedReflectionProbe.lights,
      };
    }
    signal?.throwIfAborted();
    return { data, textures, reflectionProbe, bakedReflectionProbe, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function cloneBakedReflectionProbe(probe: EnvironmentBakedReflectionProbe | undefined) {
  if (probe === undefined) return undefined;
  return {
    ...probe,
    textures: probe.textures,
    position: probe.position.clone(),
    boxMin: probe.boxMin.clone(),
    boxMax: probe.boxMax.clone(),
    lightColors: probe.lightColors.map((color) => color.clone()),
  };
}

function releaseCachedAssets(id: string, entry: CachedEnvironmentAssets) {
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs !== 0 || entry.assets === undefined) return;
  if (environmentAssetsCache.get(id) === entry) environmentAssetsCache.delete(id);
  entry.assets.dispose();
}

export async function loadEnvironmentAssets(
  id: string,
  signal?: AbortSignal,
  loadData: EnvironmentDataLoader = loadEnvironmentData,
): Promise<LoadedEnvironmentAssets> {
  // Injected loaders are predominantly used by isolated callers/tests and may
  // return mutable fixture data, so only production assets participate in the
  // cross-view cache.
  if (loadData !== loadEnvironmentData) return loadEnvironmentAssetsUncached(id, signal, loadData);

  let entry = environmentAssetsCache.get(id);
  if (entry === undefined) {
    const promise = loadEnvironmentAssetsUncached(id, undefined, loadEnvironmentData);
    entry = { refs: 0, promise };
    environmentAssetsCache.set(id, entry);
    const created = entry;
    void promise
      .then((assets) => {
        created.assets = assets;
        if (created.refs === 0) {
          if (environmentAssetsCache.get(id) === created) environmentAssetsCache.delete(id);
          assets.dispose();
        }
      })
      .catch(() => {
        if (environmentAssetsCache.get(id) === created) environmentAssetsCache.delete(id);
      });
  }

  entry.refs++;
  try {
    const assets = await entry.promise;
    signal?.throwIfAborted();
    let disposed = false;
    return {
      data: assets.data,
      textures: assets.textures,
      reflectionProbe: assets.reflectionProbe,
      bakedReflectionProbe: cloneBakedReflectionProbe(assets.bakedReflectionProbe),
      dispose() {
        if (disposed) return;
        disposed = true;
        releaseCachedAssets(id, entry);
      },
    };
  } catch (error) {
    releaseCachedAssets(id, entry);
    throw error;
  }
}
