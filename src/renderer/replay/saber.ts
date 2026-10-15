import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  TorusGeometry,
  Vector3,
  type Material,
  type ShaderMaterial,
} from 'three';

import {
  DEFAULT_REPLAY_SABER_SETTINGS,
  DEFAULT_REPLAY_TRAIL_SETTINGS,
  type ReplaySaberSettings,
  type ReplayTrailSettings,
} from '../../core/viewer-settings';

interface SaberMaterials {
  blade: Material;
  core: Material;
  metal: Material;
  grip: Material;
}

export interface ReplaySaberModel {
  root: Group;
  trailBase: Object3D;
  tip: Object3D;
  geometries: BufferGeometry[];
  blade: Mesh;
  core: Mesh;
  guard: Mesh;
  grip: Mesh;
  collars: Mesh[];
  rings: Mesh[];
  pommel: Mesh;
}

export interface ReplaySaberTrail {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  material: ShaderMaterial;
  samples: { base: Vector3; tip: Vector3 }[];
  sourceSamples: { base: Vector3; tip: Vector3 }[];
  samplePool: { base: Vector3; tip: Vector3 }[];
  settings: ReplayTrailSettings;
}

const replayTrailPredictionSpacing = 0.1;
const maximumReplayTrailPredictions = 4;

function acquireTrailSample(trail: ReplaySaberTrail) {
  const recycled = trail.samplePool.pop();
  return recycled ?? { base: new Vector3(), tip: new Vector3() };
}

function appendTrailSample(trail: ReplaySaberTrail, base: Vector3, tip: Vector3) {
  const sample = acquireTrailSample(trail);
  sample.base.copy(base);
  sample.tip.copy(tip);
  trail.samples.push(sample);
}

function tangentScale(before: Vector3, start: Vector3, end: Vector3) {
  const previousLength = before.distanceTo(start);
  return previousLength > 0 ? Math.min(start.distanceTo(end) / previousLength, 1) : 0;
}

function setHermitePoint(
  target: Vector3,
  before: Vector3,
  start: Vector3,
  end: Vector3,
  previousScale: number,
  t: number,
) {
  const t2 = t * t;
  const t3 = t2 * t;
  const startWeight = 2 * t3 - 3 * t2 + 1;
  const startTangentWeight = t3 - 2 * t2 + t;
  const endWeight = -2 * t3 + 3 * t2;
  const endTangentWeight = t3 - t2;
  target.set(
    startWeight * start.x +
      startTangentWeight * (start.x - before.x) * previousScale +
      endWeight * end.x +
      endTangentWeight * (end.x - start.x),
    startWeight * start.y +
      startTangentWeight * (start.y - before.y) * previousScale +
      endWeight * end.y +
      endTangentWeight * (end.y - start.y),
    startWeight * start.z +
      startTangentWeight * (start.z - before.z) * previousScale +
      endWeight * end.z +
      endTangentWeight * (end.z - start.z),
  );
}

function appendPredictedTrailSample(
  trail: ReplaySaberTrail,
  before: { base: Vector3; tip: Vector3 },
  start: { base: Vector3; tip: Vector3 },
  base: Vector3,
  tip: Vector3,
  baseTangentScale: number,
  tipTangentScale: number,
  t: number,
) {
  const sample = acquireTrailSample(trail);
  setHermitePoint(sample.base, before.base, start.base, base, baseTangentScale, t);
  setHermitePoint(sample.tip, before.tip, start.tip, tip, tipTangentScale, t);
  trail.samples.push(sample);
}

function appendLinearTrailSample(
  trail: ReplaySaberTrail,
  start: { base: Vector3; tip: Vector3 },
  base: Vector3,
  tip: Vector3,
  t: number,
) {
  const sample = acquireTrailSample(trail);
  sample.base.lerpVectors(start.base, base, t);
  sample.tip.lerpVectors(start.tip, tip, t);
  trail.samples.push(sample);
}

function rememberTrailSourceSample(trail: ReplaySaberTrail, base: Vector3, tip: Vector3) {
  const recycled =
    trail.sourceSamples.length >= trail.settings.replayTrailSamples ? trail.sourceSamples.shift() : undefined;
  const sample = recycled ?? { base: new Vector3(), tip: new Vector3() };
  sample.base.copy(base);
  sample.tip.copy(tip);
  trail.sourceSamples.push(sample);
}

function cylinder(radius: number, length: number, segments = 12) {
  const geometry = new CylinderGeometry(radius, radius, length, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function cone(radius: number, length: number) {
  const geometry = new ConeGeometry(radius, length, 12);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function createReplaySaber(materials: SaberMaterials): ReplaySaberModel {
  const root = new Group();
  const geometries: BufferGeometry[] = [];
  function add(geometry: BufferGeometry, material: Material, z: number) {
    const mesh = new Mesh(geometry, material);
    mesh.position.z = z;
    root.add(mesh);
    geometries.push(geometry);
    return mesh;
  }

  const defaults = DEFAULT_REPLAY_SABER_SETTINGS;
  const blade = add(cone(defaults.saberBladeThickness, defaults.saberBladeLength), materials.blade, 0);
  const core = add(
    cone(defaults.saberCoreThickness, defaults.saberBladeLength - defaults.saberCoreInset),
    materials.core,
    0,
  );
  const guard = add(
    new TorusGeometry(defaults.saberGuardSize, defaults.saberGuardThickness, 6, 32),
    materials.blade,
    0,
  );
  const grip = add(cylinder(defaults.saberGripThickness, defaults.saberGripLength, 16), materials.grip, 0);
  const collars = [
    add(new TorusGeometry(defaults.saberCollarSize, defaults.saberCollarThickness, 6, 24), materials.blade, 0),
    add(new TorusGeometry(defaults.saberCollarSize, defaults.saberCollarThickness, 6, 24), materials.blade, 0),
  ];
  const rings: Mesh[] = [];
  for (let index = 0; index < 5; index++) {
    rings.push(add(cylinder(defaults.saberRingSize, defaults.saberRingThickness, 16), materials.metal, 0));
  }
  const pommel = add(cylinder(defaults.saberPommelThickness, defaults.saberPommelLength), materials.metal, 0);

  const trailBase = new Object3D();
  const tip = new Object3D();
  root.add(trailBase, tip);
  const saber = { root, trailBase, tip, geometries, blade, core, guard, grip, collars, rings, pommel };
  setReplaySaberSettings(saber, defaults);
  return saber;
}

export function setReplaySaberSettings(saber: ReplaySaberModel, settings: ReplaySaberSettings) {
  const bladeBase = 0;
  const bladeLength = settings.saberBladeLength;
  const bladeCenter = bladeBase - bladeLength / 2;
  const coreLength = Math.max(bladeLength - settings.saberCoreInset, 0.01);
  const gripStart = 0.0032;
  const hiltEnd = gripStart + settings.saberGripLength + settings.saberPommelLength;
  saber.root.visible = settings.showSabers;
  saber.root.scale.set(
    settings.saberScale * settings.saberWidth,
    settings.saberScale * settings.saberWidth,
    settings.saberScale,
  );

  saber.blade.position.z = bladeCenter;
  saber.blade.scale.set(
    settings.saberBladeThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberBladeThickness,
    settings.saberBladeThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberBladeThickness,
    bladeLength / DEFAULT_REPLAY_SABER_SETTINGS.saberBladeLength,
  );
  saber.core.position.z = bladeCenter;
  saber.core.scale.set(
    settings.saberCoreThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberCoreThickness,
    settings.saberCoreThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberCoreThickness,
    coreLength / (DEFAULT_REPLAY_SABER_SETTINGS.saberBladeLength - DEFAULT_REPLAY_SABER_SETTINGS.saberCoreInset),
  );

  saber.guard.position.z = bladeBase + settings.saberGuardThickness;
  saber.guard.scale.set(
    settings.saberGuardSize / DEFAULT_REPLAY_SABER_SETTINGS.saberGuardSize,
    settings.saberGuardSize / DEFAULT_REPLAY_SABER_SETTINGS.saberGuardSize,
    settings.saberGuardThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberGuardThickness,
  );
  saber.grip.position.z = bladeBase + gripStart + settings.saberGripLength / 2;
  saber.grip.scale.set(
    settings.saberGripThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberGripThickness,
    settings.saberGripThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberGripThickness,
    settings.saberGripLength / DEFAULT_REPLAY_SABER_SETTINGS.saberGripLength,
  );

  saber.collars.forEach((collar, index) => {
    collar.position.z = bladeBase + hiltEnd / 2 + 0.008 + (index === 0 ? -0.5 : 0.5) * settings.saberCollarSpacing;
    collar.scale.set(
      settings.saberCollarSize / DEFAULT_REPLAY_SABER_SETTINGS.saberCollarSize,
      settings.saberCollarSize / DEFAULT_REPLAY_SABER_SETTINGS.saberCollarSize,
      settings.saberCollarThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberCollarThickness,
    );
  });

  saber.rings.forEach((ring, index) => {
    ring.visible = index < settings.saberRingCount;
    ring.position.z =
      bladeBase + hiltEnd * 0.53 + (index - (settings.saberRingCount - 1) / 2) * settings.saberRingSpacing;
    ring.scale.set(
      settings.saberRingSize / DEFAULT_REPLAY_SABER_SETTINGS.saberRingSize,
      settings.saberRingSize / DEFAULT_REPLAY_SABER_SETTINGS.saberRingSize,
      settings.saberRingThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberRingThickness,
    );
  });

  saber.pommel.position.z = bladeBase + gripStart + settings.saberGripLength + settings.saberPommelLength / 2;
  saber.pommel.scale.set(
    settings.saberPommelThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberPommelThickness,
    settings.saberPommelThickness / DEFAULT_REPLAY_SABER_SETTINGS.saberPommelThickness,
    settings.saberPommelLength / DEFAULT_REPLAY_SABER_SETTINGS.saberPommelLength,
  );
  saber.tip.position.z = bladeBase - bladeLength;
  saber.trailBase.position.z = saber.tip.position.z + settings.replayTrailLength;
}

function configureTrailGeometry(trail: ReplaySaberTrail) {
  const trailSamples =
    trail.settings.replayTrailSamples * (trail.settings.replayTrailSmoothing ? maximumReplayTrailPredictions + 1 : 1);
  const geometry = trail.mesh.geometry;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(trailSamples * 6), 3));
  geometry.setAttribute('trailAlpha', new BufferAttribute(new Float32Array(trailSamples * 2), 1));
  geometry.setAttribute('trailUv', new BufferAttribute(new Float32Array(trailSamples * 4), 2));
  const indices = new Uint16Array((trailSamples - 1) * 6);
  for (let index = 0; index < trailSamples - 1; index++) {
    const offset = index * 6;
    const vertex = index * 2;
    indices.set([vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3], offset);
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
}

function recycleRenderedTrailSamples(trail: ReplaySaberTrail) {
  while (trail.samples.length > 0) {
    const sample = trail.samples.pop();
    if (sample !== undefined) trail.samplePool.push(sample);
  }
}

function rebuildReplaySaberTrail(trail: ReplaySaberTrail) {
  recycleRenderedTrailSamples(trail);
  const first = trail.sourceSamples[0];
  if (first === undefined) {
    trail.mesh.geometry.setDrawRange(0, 0);
    return;
  }

  appendTrailSample(trail, first.base, first.tip);
  for (let sourceIndex = 1; sourceIndex < trail.sourceSamples.length; sourceIndex++) {
    const start = trail.sourceSamples[sourceIndex - 1];
    const end = trail.sourceSamples[sourceIndex];
    if (start === undefined || end === undefined) continue;
    const before = trail.sourceSamples[sourceIndex - 2];
    const predictions = trail.settings.replayTrailSmoothing
      ? Math.min(
          maximumReplayTrailPredictions,
          Math.max(0, Math.ceil(start.tip.distanceTo(end.tip) / replayTrailPredictionSpacing) - 1),
        )
      : 0;
    const baseTangentScale = before === undefined ? 0 : tangentScale(before.base, start.base, end.base);
    const tipTangentScale = before === undefined ? 0 : tangentScale(before.tip, start.tip, end.tip);
    for (let predictionIndex = 1; predictionIndex <= predictions; predictionIndex++) {
      const t = predictionIndex / (predictions + 1);
      if (before === undefined) appendLinearTrailSample(trail, start, end.base, end.tip, t);
      else {
        appendPredictedTrailSample(
          trail,
          before,
          start,
          end.base,
          end.tip,
          baseTangentScale,
          tipTangentScale,
          t,
        );
      }
    }
    appendTrailSample(trail, end.base, end.tip);
  }
  writeReplaySaberTrail(trail);
}

function writeReplaySaberTrail(trail: ReplaySaberTrail) {
  const position = trail.mesh.geometry.getAttribute('position');
  const alpha = trail.mesh.geometry.getAttribute('trailAlpha');
  const uv = trail.mesh.geometry.getAttribute('trailUv');
  const denominator = Math.max(trail.samples.length - 1, 1);
  trail.samples.forEach((sample, index) => {
    const span = index / denominator;
    const styleCollapse = trail.settings.replayTrailStyle === 'flag' ? (1 - span) * 0.5 : 0;
    const collapse = styleCollapse + (0.5 - styleCollapse) * trail.settings.replayTrailThinness;
    position.setXYZ(
      index * 2,
      sample.base.x + (sample.tip.x - sample.base.x) * collapse,
      sample.base.y + (sample.tip.y - sample.base.y) * collapse,
      sample.base.z + (sample.tip.z - sample.base.z) * collapse,
    );
    position.setXYZ(
      index * 2 + 1,
      sample.tip.x + (sample.base.x - sample.tip.x) * collapse,
      sample.tip.y + (sample.base.y - sample.tip.y) * collapse,
      sample.tip.z + (sample.base.z - sample.tip.z) * collapse,
    );
    const opacity = span ** trail.settings.replayTrailFade * trail.settings.replayTrailOpacity;
    alpha.setX(index * 2, opacity);
    alpha.setX(index * 2 + 1, opacity);
    uv.setXY(index * 2, 1 - span, 1);
    uv.setXY(index * 2 + 1, 1 - span, 0);
  });
  position.needsUpdate = true;
  alpha.needsUpdate = true;
  uv.needsUpdate = true;
  trail.mesh.geometry.setDrawRange(0, Math.max(trail.samples.length - 1, 0) * 6);
}

export function createReplaySaberTrail(
  material: ShaderMaterial,
  settings = DEFAULT_REPLAY_TRAIL_SETTINGS,
): ReplaySaberTrail {
  const geometry = new BufferGeometry();
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = settings.showSaberTrails;
  const trail = { mesh, material, samples: [], sourceSamples: [], samplePool: [], settings: { ...settings } };
  configureTrailGeometry(trail);
  return trail;
}

export function setReplaySaberTrailSettings(trail: ReplaySaberTrail, settings: ReplayTrailSettings) {
  const geometryChanged =
    settings.replayTrailSamples !== trail.settings.replayTrailSamples ||
    settings.replayTrailSmoothing !== trail.settings.replayTrailSmoothing;
  trail.settings = { ...settings };
  trail.mesh.visible = settings.showSaberTrails;
  if (trail.sourceSamples.length > settings.replayTrailSamples) {
    trail.sourceSamples.splice(0, trail.sourceSamples.length - settings.replayTrailSamples);
  }
  if (geometryChanged) configureTrailGeometry(trail);
  rebuildReplaySaberTrail(trail);
}

export function setReplaySaberTrailMaterial(trail: ReplaySaberTrail, material: ShaderMaterial) {
  trail.material = material;
  trail.mesh.material = material;
}

export function clearReplaySaberTrail(trail: ReplaySaberTrail) {
  recycleRenderedTrailSamples(trail);
  trail.sourceSamples.length = 0;
  trail.mesh.geometry.setDrawRange(0, 0);
}

export function updateReplaySaberTrail(trail: ReplaySaberTrail, base: Vector3, tip: Vector3) {
  const previous = trail.sourceSamples.at(-1);
  const threshold = trail.settings.replayTrailMotionThreshold;
  if (previous !== undefined && previous.tip.distanceToSquared(tip) < threshold * threshold) return;

  rememberTrailSourceSample(trail, base, tip);
  rebuildReplaySaberTrail(trail);
}
