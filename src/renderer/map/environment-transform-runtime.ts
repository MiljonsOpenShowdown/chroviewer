import { Quaternion, Vector3, type Object3D } from 'three';

import type {
  EventBox,
  FloatFxEvent,
  LightRotationEvent,
  LightTransformEventBox,
  LightTranslationEvent,
} from '../../core/beatmap/types';
import { expandGlsEvents } from '../../core/lighting/gls-events';
import {
  floatFxTween,
  glsRotationTween,
  glsTweenSettledUntil,
  sampleGlsFloat,
  sampleGlsRotationTween,
  translationTween,
} from '../../core/lighting/gls-sampling';
import {
  createLightPairRotationSampler,
  createLightRotationSampler,
  deterministicRotationRandom,
} from '../../core/lighting/light-rotation';
import {
  createRingPositionSampler,
  createRingRotationSampler,
  deterministicRingRandom,
} from '../../core/lighting/ring-motion';
import type { MapRenderData } from '../../core/placement/map-render-data';
import type {
  EnvironmentGlsFxTarget,
  EnvironmentGlsTransformEntry,
  LoadedEnvironment,
} from '../environment/environment-runtime';
import { menuLightshowRandom } from './menu-lightshow';

// `settled` is the sampled rotation or translation, still valid for beats from `settledFrom` until `settledUntil`
interface GlsRotationRuntime {
  entry: EnvironmentGlsTransformEntry;
  tween: ReturnType<typeof glsRotationTween>;
  initial: { target: Object3D; value: Quaternion }[];
  settled: Quaternion;
  settledFrom: number;
  settledUntil: number;
}

interface GlsTranslationRuntime {
  entry: EnvironmentGlsTransformEntry;
  tween: ReturnType<typeof translationTween>;
  initial: { target: Object3D; value: Vector3 }[];
  settled: number;
  settledFrom: number;
  settledUntil: number;
}

interface GlsFxRuntime {
  targets: EnvironmentGlsFxTarget[];
  tween: ReturnType<typeof floatFxTween>;
  trigger: boolean;
}

interface RingRuntime {
  group: LoadedEnvironment['ringGroups'][number];
  fullRotation?: ReturnType<typeof createRingRotationSampler>;
  restingRotation?: ReturnType<typeof createRingRotationSampler>;
  fullPosition?: ReturnType<typeof createRingPositionSampler>;
  restingPosition?: ReturnType<typeof createRingPositionSampler>;
}

interface RotationRuntime {
  rotation: LoadedEnvironment['rotations'][number];
  full: (beat: number) => number;
  resting: (beat: number) => number;
}

const zAxis = new Vector3(0, 0, 1);
const degToRad = Math.PI / 180;

/**
 * Object.is per component, so writing would change nothing, not even the sign
 * of a zero. Skipping those targets skips their matrix and world matrix updates.
 */
function sameQuaternion(target: Quaternion, value: Quaternion) {
  return (
    Object.is(target.x, value.x) &&
    Object.is(target.y, value.y) &&
    Object.is(target.z, value.z) &&
    Object.is(target.w, value.w)
  );
}

export class EnvironmentTransformRuntime {
  private readonly rotationQuaternion = new Quaternion();
  private readonly rotationAxis = new Vector3();
  private readonly changedMatrices = new Set<Object3D>();
  private glsRotationRuntime: GlsRotationRuntime[] = [];
  private glsTranslationRuntime: GlsTranslationRuntime[] = [];
  private glsFxRuntime: GlsFxRuntime[] = [];
  private ringRuntime: RingRuntime[] = [];
  private rotationRuntime: RotationRuntime[] = [];
  private menuLightshow: { environment: LoadedEnvironment; seed: number } | null = null;

  rebuild(
    environment: LoadedEnvironment,
    data: MapRenderData,
    jsonTimeToSongBpmTime: (jsonTime: number) => number,
    eventsForType: (eventType: number) => MapRenderData['lightEvents'],
  ) {
    this.menuLightshow = null;
    this.ringRuntime = environment.ringGroups.map((group) => {
      const runtime: RingRuntime = { group };
      if (group.rotationConfig !== undefined && group.rotationEventType !== undefined) {
        const random = deterministicRingRandom(group.seed);
        runtime.fullRotation = createRingRotationSampler(
          eventsForType(group.rotationEventType),
          data.songBpm,
          group.initialRotations,
          group.rotationConfig,
          random,
        );
        runtime.restingRotation = createRingRotationSampler(
          [],
          data.songBpm,
          group.initialRotations,
          group.rotationConfig,
          random,
        );
      }
      if (group.positionConfig !== undefined && group.positionEventType !== undefined) {
        runtime.fullPosition = createRingPositionSampler(
          eventsForType(group.positionEventType),
          data.songBpm,
          group.positionConfig,
        );
        runtime.restingPosition = createRingPositionSampler([], data.songBpm, group.positionConfig);
      }
      return runtime;
    });
    this.rotationRuntime = environment.rotations.map((rotation) => {
      const random = deterministicRotationRandom(rotation.seed);
      function create(source: MapRenderData['lightEvents']) {
        return rotation.pair === undefined
          ? createLightRotationSampler(source, data.songBpm, rotation.speedMultiplier, random)
          : createLightPairRotationSampler(
              source,
              data.songBpm,
              rotation.pair.mirrored,
              rotation.pair.startAngle,
              random,
            );
      }
      return {
        rotation,
        full: create(eventsForType(rotation.eventType)),
        resting: create([]),
      };
    });

    this.glsRotationRuntime = [];
    for (const environmentGroup of environment.glsRotationGroups) {
      const groups = data.lightRotationEventBoxGroups.filter((group) => group.id === environmentGroup.groupId);
      const expanded = expandGlsEvents<LightRotationEvent, LightTransformEventBox<LightRotationEvent>>(
        groups,
        environmentGroup.count,
        (box) => box.axis,
      );
      for (const entry of environmentGroup.entries) {
        this.glsRotationRuntime.push({
          entry,
          tween: glsRotationTween(
            expanded.filter((event) => event.element === entry.id && event.axis === entry.axis),
            jsonTimeToSongBpmTime,
          ),
          initial: entry.targets.map((target) => ({ target, value: target.quaternion.clone() })),
          settled: new Quaternion(),
          settledFrom: Number.NaN,
          settledUntil: Number.NaN,
        });
      }
    }

    this.glsTranslationRuntime = [];
    for (const environmentGroup of environment.glsTranslationGroups) {
      const groups = data.lightTranslationEventBoxGroups.filter((group) => group.id === environmentGroup.groupId);
      const expanded = expandGlsEvents<LightTranslationEvent, LightTransformEventBox<LightTranslationEvent>>(
        groups,
        environmentGroup.count,
        (box) => box.axis,
      );
      for (const entry of environmentGroup.entries) {
        const events = expanded.filter((event) => event.element === entry.id && event.axis === entry.axis);
        const limits = environmentGroup.translationLimits[entry.axis] ?? [0, 0];
        const distributionLimits = environmentGroup.distributionLimits[entry.axis] ?? [0, 0];
        this.glsTranslationRuntime.push({
          entry,
          tween: translationTween(events, jsonTimeToSongBpmTime, limits, distributionLimits, entry.mirrored),
          initial: entry.targets.map((target) => ({ target, value: target.position.clone() })),
          settled: 0,
          settledFrom: Number.NaN,
          settledUntil: Number.NaN,
        });
      }
    }

    this.glsFxRuntime = [];
    for (const environmentGroup of environment.glsFxGroups) {
      const groups = data.fxEventBoxGroups.filter((group) => group.id === environmentGroup.groupId);
      const expanded = expandGlsEvents<FloatFxEvent, EventBox<FloatFxEvent>>(groups, environmentGroup.count);
      for (const entry of environmentGroup.entries) {
        const events = expanded.filter((event) => event.element === entry.id);
        this.glsFxRuntime.push({
          targets: entry.targets,
          tween: floatFxTween(events, jsonTimeToSongBpmTime),
          trigger: environmentGroup.trigger,
        });
      }
    }
  }

  rebuildMenuLightshow(environment: LoadedEnvironment, seed: number) {
    this.clear();
    this.menuLightshow = { environment, seed };
  }

  clear() {
    this.menuLightshow = null;
    this.glsRotationRuntime = [];
    this.glsTranslationRuntime = [];
    this.glsFxRuntime = [];
    this.ringRuntime = [];
    this.rotationRuntime = [];
  }

  update(beat: number, full: boolean) {
    if (this.menuLightshow !== null) {
      this.updateMenuLightshow(beat, this.menuLightshow.environment, this.menuLightshow.seed);
      return;
    }
    const changed = this.changedMatrices;
    changed.clear();
    for (const runtime of this.rotationRuntime) {
      const rotation = runtime.rotation;
      const angle = (full ? runtime.full : runtime.resting)(beat);
      this.rotationAxis.fromArray(rotation.axis).normalize();
      this.rotationQuaternion.setFromAxisAngle(this.rotationAxis, angle * degToRad);
      rotation.target.quaternion.fromArray(rotation.startRotation).multiply(this.rotationQuaternion);
      changed.add(rotation.target);
    }
    for (const runtime of this.ringRuntime) {
      const group = runtime.group;
      const rotationSampler = full ? runtime.fullRotation : runtime.restingRotation;
      if (rotationSampler !== undefined) {
        const rotations = rotationSampler(beat);
        group.rings.forEach((ring, index) => {
          ring.target.quaternion.setFromAxisAngle(zAxis, (rotations[index] ?? 0) * degToRad);
          changed.add(ring.target);
        });
      }
      const positionSampler = full ? runtime.fullPosition : runtime.restingPosition;
      if (positionSampler !== undefined) {
        const positions = positionSampler(beat);
        group.rings.forEach((ring, index) => {
          ring.target.position.set(
            ring.positionOffset[0],
            ring.positionOffset[1],
            -(positions[index] ?? ring.positionOffset[2]),
          );
          changed.add(ring.target);
        });
      }
    }
    for (const runtime of this.glsRotationRuntime) {
      const firstEventTime = runtime.tween[0]?.time;
      if (!full || firstEventTime === undefined || beat < firstEventTime) {
        for (const { target, value } of runtime.initial) {
          if (sameQuaternion(target.quaternion, value)) continue;
          target.quaternion.copy(value);
          changed.add(target);
        }
        continue;
      }
      // Most entries hold still most of the time: reuse the last rotation while it holds
      const rotation = runtime.settled;
      if (!(runtime.settledFrom <= beat && beat < runtime.settledUntil)) {
        let angle = sampleGlsRotationTween(runtime.tween, beat);
        if (runtime.entry.mirrored) angle *= -1;
        const axis = runtime.entry.axis;
        this.rotationAxis.set(axis === 0 ? -1 : 0, axis === 1 ? -1 : 0, axis === 2 ? 1 : 0);
        rotation.setFromAxisAngle(this.rotationAxis, angle * degToRad);
        runtime.settledFrom = beat;
        runtime.settledUntil = glsTweenSettledUntil(runtime.tween, beat, true);
      }
      // Still written while settled: another entry or system may have turned the target since
      for (const target of runtime.entry.targets) {
        if (sameQuaternion(target.quaternion, rotation)) continue;
        target.quaternion.copy(rotation);
        changed.add(target);
      }
    }
    for (const runtime of this.glsTranslationRuntime) {
      const firstEventTime = runtime.tween[0]?.time;
      if (!full || firstEventTime === undefined || beat < firstEventTime) {
        for (const { target, value } of runtime.initial) {
          const position = target.position;
          if (Object.is(position.x, value.x) && Object.is(position.y, value.y) && Object.is(position.z, value.z)) {
            continue;
          }
          position.copy(value);
          changed.add(target);
        }
        continue;
      }
      if (!(runtime.settledFrom <= beat && beat < runtime.settledUntil)) {
        runtime.settled = sampleGlsFloat(runtime.tween, beat);
        runtime.settledFrom = beat;
        runtime.settledUntil = glsTweenSettledUntil(runtime.tween, beat, false);
      }
      const value = runtime.settled;
      const axis = runtime.entry.axis;
      const component = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      const written = axis === 0 || axis === 1 ? value : -value;
      for (const target of runtime.entry.targets) {
        if (Object.is(target.position[component], written)) continue;
        target.position[component] = written;
        changed.add(target);
      }
    }
    for (const runtime of this.glsFxRuntime) {
      const firstEventTime = runtime.tween[0]?.time;
      // game zeroes non-trigger fx targets at construction, overriding material defaults
      if (!full || (runtime.trigger && (firstEventTime === undefined || beat < firstEventTime))) {
        for (const target of runtime.targets) target.reset();
        continue;
      }
      const value = sampleGlsFloat(runtime.tween, beat);
      for (const target of runtime.targets) target.apply(value);
    }
    for (const target of changed) target.updateMatrix();
  }

  private updateMenuLightshow(beat: number, environment: LoadedEnvironment, seed: number) {
    const changed = this.changedMatrices;
    changed.clear();
    for (const rotation of environment.rotations) {
      const phase = menuLightshowRandom(seed, rotation.seed, 0) * 360;
      const direction = rotation.pair?.mirrored === true || rotation.speedMultiplier < 0 ? -1 : 1;
      const speed = Math.min(Math.max(Math.abs(rotation.speedMultiplier), 0.75), 2) * 3;
      this.rotationAxis.fromArray(rotation.axis).normalize();
      this.rotationQuaternion.setFromAxisAngle(this.rotationAxis, (phase + beat * speed * direction) * degToRad);
      rotation.target.quaternion.fromArray(rotation.startRotation).multiply(this.rotationQuaternion);
      changed.add(rotation.target);
    }
    for (const group of environment.ringGroups) {
      const phase = menuLightshowRandom(seed, group.seed, 1) * Math.PI * 2;
      const centre = (menuLightshowRandom(seed, group.seed, 2) - 0.5) * 24;
      group.rings.forEach((ring, index) => {
        const angle = centre + Math.sin(beat * 0.12 + index * 0.36 + phase) * 16;
        ring.target.quaternion.setFromAxisAngle(zAxis, angle * degToRad);
        changed.add(ring.target);
      });
    }
    for (const target of changed) target.updateMatrix();
  }
}
