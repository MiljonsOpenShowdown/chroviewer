import { Result } from 'better-result';

import { parseHitScoreVisualizerProfile } from '../../core/replay/hit-score-visualizer-profile';
import { applyScoreSaberReplayExtension } from '../../core/replay/parse-scoresaber';
import type {
  Replay,
  ReplayColor,
  ReplayNoteEvent,
  ReplayNoteEventType as ViewerReplayNoteEventType,
  ReplayPauseEvent as ViewerReplayPauseEvent,
  ReplayPose,
  ReplayQuaternion as ViewerReplayQuaternion,
  ReplayTransform,
  ReplayVector3 as ViewerReplayVector3,
} from '../../core/replay/types';
import {
  ReplayNoteEventType,
  type ReplayExtension,
  type ReplayNoteEvent as LiveReplayNoteEvent,
  type ReplayPauseEvent,
  type ReplayPose as LiveReplayPose,
  type ReplayPoseFrame,
  type ReplayQuaternion,
  type ReplayStreamStart,
  type ReplayVector3,
} from './generated/proto/scoresaber/live/v1/replay_stream_pb';

// Static cosmetic extensions are often repeated by live publishers. Cache per
// replay, never globally: each player retains their own colors and HSV profile.
const cosmeticExtensions = new WeakMap<Replay, Map<string, Uint8Array>>();
const cosmeticExtensionIds = new Set([
  'ta.hsv-profile',
  'scoresaber.hsv-config',
  'scoresaber.play-settings',
  'scoresaber.controller-offsets',
]);

function vector(value?: ReplayVector3): ViewerReplayVector3 {
  return value === undefined ? { x: 0, y: 0, z: 0 } : { x: value.x, y: value.y, z: value.z };
}

function quaternion(value?: ReplayQuaternion): ViewerReplayQuaternion {
  return value === undefined ? { x: 0, y: 0, z: 0, w: 1 } : { x: value.x, y: value.y, z: value.z, w: value.w };
}

function transform(value?: LiveReplayPose): ReplayTransform {
  return { position: vector(value?.position), rotation: quaternion(value?.rotation) };
}

function replayColor(value: { r: number; g: number; b: number; a: number } | undefined): ReplayColor | undefined {
  return value === undefined ? undefined : { x: value.r, y: value.g, z: value.b, a: value.a };
}

export function normalizeLiveMapHash(value: string) {
  return value
    .trim()
    .replace(/^custom_level_/i, '')
    .slice(0, 40)
    .toUpperCase();
}

export function liveMapHash(start: ReplayStreamStart) {
  let value = start.beatmap?.mapHash;
  if (value === undefined || value === '') value = start.replayMetadata?.levelId;
  return normalizeLiveMapHash(value ?? '');
}

export function createLiveReplay(start: ReplayStreamStart, useSaberColorsForEnvironment = false): Replay {
  const metadata = start.replayMetadata;
  const beatmap = start.beatmap;
  const hash = liveMapHash(start);
  const modifiers = beatmap?.modifiers.length ? beatmap.modifiers : (metadata?.modifiers ?? []);
  const version = metadata?.replayVersion;
  const levelId = metadata?.levelId;
  const difficulty = beatmap?.difficulty;
  let characteristic = beatmap?.characteristic;
  if (characteristic === undefined || characteristic === '') characteristic = metadata?.characteristic;
  if (characteristic === undefined || characteristic === '') characteristic = 'Standard';
  const leftSaberColor = replayColor(metadata?.leftSaberColor);
  const rightSaberColor = replayColor(metadata?.rightSaberColor);
  const replay: Replay = {
    metadata: {
      version: version === undefined || version === '' ? 'live' : version,
      levelId: levelId === undefined || levelId === '' ? `custom_level_${hash}` : levelId,
      difficulty: difficulty === undefined || difficulty === 0 ? (metadata?.difficulty ?? 0) : difficulty,
      characteristic: characteristic.replace(/^Solo/i, ''),
      environment: metadata?.environment ?? '',
      modifiers: [...modifiers],
      noteSpawnOffset: metadata?.noteSpawnOffset ?? 0,
      leftHanded: metadata?.leftHanded ?? false,
      initialHeight:
        metadata?.initialHeight === undefined || metadata.initialHeight === 0 ? 1.7 : metadata.initialHeight,
      roomRotation: metadata?.roomRotation ?? 0,
      roomCenter: vector(metadata?.roomCenter),
      failTime: metadata?.failTimeSeconds ?? 0,
      gameVersion: metadata?.gameVersion,
      pluginVersion: metadata?.pluginVersion,
      platform: metadata?.platform,
      hasPlaySettings: metadata !== undefined,
      songSpeed: metadata?.songSpeed,
      jumpDistance: metadata?.jumpDistance,
      leftSaberColor,
      rightSaberColor,
      // TA currently records the player's two gameplay colors. Use those for
      // the corresponding environment channels as well, which is the closest
      // representation available without inventing colors absent from the
      // stream. ChroViewer's replay-color resolver applies these to notes,
      // sabers, trails, mapped lights, and boosted light events.
      environmentColor0: useSaberColorsForEnvironment ? leftSaberColor : undefined,
      environmentColor1: useSaberColorsForEnvironment ? rightSaberColor : undefined,
      environmentColor0Boost: useSaberColorsForEnvironment ? leftSaberColor : undefined,
      environmentColor1Boost: useSaberColorsForEnvironment ? rightSaberColor : undefined,
      supportsEnvironmentColorBoost:
        useSaberColorsForEnvironment && leftSaberColor !== undefined && rightSaberColor !== undefined,
    },
    poses: [],
    heights: [],
    notes: [],
    scores: [],
    combos: [],
    multipliers: [],
    energies: [],
    pauses: [],
    walls: [],
  };
  applyLiveReplayExtensions(replay, start.replayExtensions, false);
  return replay;
}

export function livePose(frame: ReplayPoseFrame): ReplayPose {
  return {
    time: frame.timeSeconds,
    fps: frame.fps || 90,
    head: transform(frame.head),
    leftHand: transform(frame.left),
    rightHand: transform(frame.right),
  };
}

function noteEventType(value: ReplayNoteEventType): ViewerReplayNoteEventType {
  switch (value) {
    case ReplayNoteEventType.GOOD_CUT:
      return 1;
    case ReplayNoteEventType.BAD_CUT:
      return 2;
    case ReplayNoteEventType.MISS:
      return 3;
    case ReplayNoteEventType.BOMB:
      return 4;
    default:
      return 0;
  }
}

export function liveNote(event: LiveReplayNoteEvent): ReplayNoteEvent {
  const id = event.noteId;
  return {
    noteId: {
      time: id?.timeSeconds ?? 0,
      lineLayer: id?.lineLayer ?? -1,
      lineIndex: id?.lineIndex ?? -1,
      colorType: id?.colorType ?? -1,
      cutDirection: id?.cutDirection ?? -1,
      gameplayType: id?.gameplayType,
      scoringType: id?.scoringType,
      cutDirectionAngleOffset: id?.cutDirectionAngleOffset,
    },
    eventType: noteEventType(event.eventType),
    cutPoint: vector(event.cutPoint),
    cutNormal: vector(event.cutNormal),
    saberDirection: vector(event.saberDirection),
    saberType: event.saberType,
    directionOk: event.directionOk,
    saberSpeed: event.saberSpeed,
    cutAngle: event.cutAngle,
    cutDistanceToCenter: event.cutDistanceToCenter,
    cutDirectionDeviation: event.cutDirectionDeviation,
    beforeCutRating: event.beforeCutRating,
    afterCutRating: event.afterCutRating,
    time: event.timeSeconds,
    unityTimescale: event.unityTimescale,
    timeSyncTimescale: event.timeSyncTimescale,
    timeDeviation: event.timeDeviation,
    worldRotation: event.worldRotation === undefined ? undefined : quaternion(event.worldRotation),
    inverseWorldRotation: event.inverseWorldRotation === undefined ? undefined : quaternion(event.inverseWorldRotation),
    noteRotation: event.noteRotation === undefined ? undefined : quaternion(event.noteRotation),
    notePosition: event.notePosition === undefined ? undefined : vector(event.notePosition),
  };
}

export function appendLivePause(replay: Replay, event: ReplayPauseEvent) {
  if (event.paused) {
    const pause: ViewerReplayPauseEvent = {
      time: event.timeSeconds,
      duration: 0n,
      unixStartTime: event.clientTimeUnixMs,
      unixEndTime: event.clientTimeUnixMs,
    };
    replay.pauses.push(pause);
    return pause;
  }
  const pause = replay.pauses.at(-1);
  if (pause?.duration === 0n) {
    pause.unixEndTime = event.clientTimeUnixMs;
    if (event.clientTimeUnixMs >= pause.unixStartTime) {
      pause.duration = (event.clientTimeUnixMs - pause.unixStartTime) / 1000n;
    } else {
      pause.duration = BigInt(Math.max(0, Math.round(event.timeSeconds - pause.time)));
    }
  }
  return pause;
}

export function applyLiveReplayExtensions(replay: Replay, extensions: ReplayExtension[], append: boolean) {
  for (const extension of extensions) {
    const cosmetic = extension.version === 1 && cosmeticExtensionIds.has(extension.id);
    const cached = cosmeticExtensions.get(replay)?.get(extension.id);
    if (
      cosmetic &&
      cached?.length === extension.payload.length &&
      cached.every((byte, index) => byte === extension.payload[index])
    )
      continue;
    const result = Result.try(() => {
      // Quest HitScoreVisualizer does not expose ScoreSaber PC's binary codec.
      // Keep this bounded HSV-only fallback distinct instead of mislabelling JSON
      // as a scoresaber.hsv-config payload.
      if (extension.id === 'ta.hsv-profile' && extension.version === 1) {
        const profile = new TextDecoder('utf-8', { fatal: true }).decode(extension.payload);
        if (parseHitScoreVisualizerProfile(profile).isErr()) throw new Error('invalid TA HSV profile');
        replay.hsvProfile = profile;
        return;
      }
      applyScoreSaberReplayExtension(replay, extension.id, extension.version, extension.payload, append);
    });
    if (result.isErr()) console.warn(`ignoring live replay extension ${extension.id}`, result.error);
    else if (cosmetic) {
      let cache = cosmeticExtensions.get(replay);
      if (cache === undefined) {
        cache = new Map();
        cosmeticExtensions.set(replay, cache);
      }
      cache.set(extension.id, extension.payload.slice());
    }
  }
}

export function replayLightshowMode(replay: Replay) {
  switch (replay.metadata.environmentEffectsFilterPreset) {
    case 1:
      return 'static' as const;
    case 10:
      return 'none' as const;
    default:
      return 'full' as const;
  }
}
