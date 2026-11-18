import { mirrorCutDirection } from '../placement/map-render-data';
import type {
  Replay,
  ReplayColor,
  ReplayControllerOffset,
  ReplayControllerOffsets,
  ReplayMetadata,
  ReplayNoteEvent,
  ReplayNoteId,
  ReplayQuaternion,
  ReplayTransform,
  ReplayVector3,
  ReplayWallEvent,
} from './types';

const laneCount = 4;

// Positions and directions flip across the YZ plane. A rotation is a pseudovector, so its quaternion keeps
// x and w and flips y and z (the same relation as `setNoodleQuaternion` between its left- and right-handed branches).
function mirrorVector(vector: ReplayVector3): ReplayVector3 {
  return { x: -vector.x, y: vector.y, z: vector.z };
}

function mirrorQuaternion(rotation: ReplayQuaternion): ReplayQuaternion {
  return { x: rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w };
}

function mirrorTransform(transform: ReplayTransform): ReplayTransform {
  return { position: mirrorVector(transform.position), rotation: mirrorQuaternion(transform.rotation) };
}

// Euler degrees of a rotation mirror like the quaternion: x stays, y and z flip.
function mirrorControllerOffset(offset: ReplayControllerOffset): ReplayControllerOffset {
  return {
    position: mirrorVector(offset.position),
    rotation: { x: offset.rotation.x, y: -offset.rotation.y, z: -offset.rotation.z },
  };
}

function mirrorControllerOffsets(offsets: ReplayControllerOffsets): ReplayControllerOffsets {
  const mirrored: ReplayControllerOffsets = {};
  if (offsets.shared !== undefined) mirrored.shared = mirrorControllerOffset(offsets.shared);
  if (offsets.right !== undefined) mirrored.left = mirrorControllerOffset(offsets.right);
  if (offsets.left !== undefined) mirrored.right = mirrorControllerOffset(offsets.left);
  return mirrored;
}

function mirrorNoteId(id: ReplayNoteId): ReplayNoteId {
  const mirrored: ReplayNoteId = {
    ...id,
    lineIndex: laneCount - 1 - id.lineIndex,
    colorType: 1 - id.colorType,
    cutDirection: mirrorCutDirection(id.cutDirection),
  };
  if (id.cutDirectionAngleOffset !== undefined) mirrored.cutDirectionAngleOffset = -id.cutDirectionAngleOffset;
  return mirrored;
}

function mirrorNoteEvent(event: ReplayNoteEvent): ReplayNoteEvent {
  const mirrored: ReplayNoteEvent = {
    ...event,
    noteId: mirrorNoteId(event.noteId),
    cutPoint: mirrorVector(event.cutPoint),
    cutNormal: mirrorVector(event.cutNormal),
    saberDirection: mirrorVector(event.saberDirection),
    saberType: 1 - event.saberType,
  };
  if (event.worldRotation !== undefined) mirrored.worldRotation = mirrorQuaternion(event.worldRotation);
  if (event.inverseWorldRotation !== undefined) {
    mirrored.inverseWorldRotation = mirrorQuaternion(event.inverseWorldRotation);
  }
  if (event.noteRotation !== undefined) mirrored.noteRotation = mirrorQuaternion(event.noteRotation);
  if (event.notePosition !== undefined) mirrored.notePosition = mirrorVector(event.notePosition);
  return mirrored;
}

// A wall covers lanes lineIndex .. lineIndex + width - 1, so its mirror starts at laneCount - lineIndex - width.
function mirrorWallEvent(wall: ReplayWallEvent): ReplayWallEvent {
  return { ...wall, lineIndex: laneCount - wall.lineIndex - wall.width };
}

function swapColors(
  left: ReplayColor | undefined,
  right: ReplayColor | undefined,
): Pick<ReplayMetadata, 'leftSaberColor' | 'rightSaberColor'> {
  return { leftSaberColor: right, rightSaberColor: left };
}

function mirrorMetadata(metadata: ReplayMetadata): ReplayMetadata {
  const mirrored: ReplayMetadata = {
    ...metadata,
    leftHanded: false,
    roomRotation: -metadata.roomRotation,
    roomCenter: mirrorVector(metadata.roomCenter),
    ...swapColors(metadata.leftSaberColor, metadata.rightSaberColor),
  };
  if (metadata.controllerOffsets !== undefined) {
    mirrored.controllerOffsets = mirrorControllerOffsets(metadata.controllerOffsets);
  }
  return mirrored;
}

/**
 * Turns a left-handed replay into the right-handed one that plays on the unmirrored map. The game mirrors the map for
 * left-handed players, so poses and note events are flipped across the YZ plane and the hands swap. The input is
 * not modified, and a replay that is not left-handed is returned as is.
 */
export function mirrorLeftHandedReplay(replay: Replay): Replay {
  if (!replay.metadata.leftHanded) return replay;
  return {
    ...replay,
    metadata: mirrorMetadata(replay.metadata),
    poses: replay.poses.map((pose) => ({
      ...pose,
      head: mirrorTransform(pose.head),
      leftHand: mirrorTransform(pose.rightHand),
      rightHand: mirrorTransform(pose.leftHand),
    })),
    notes: replay.notes.map(mirrorNoteEvent),
    walls: replay.walls.map(mirrorWallEvent),
  };
}
