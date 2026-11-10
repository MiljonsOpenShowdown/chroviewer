import { create, fromBinary } from '@bufbuild/protobuf';

import type { Replay } from '../../core/replay/types';
import {
  ReplayCompletion,
  ReplayPoseFrameSchema,
  ReplayStreamPacketSchema,
  type ReplayStreamPacket,
  type ReplayChunk,
  type ReplayStreamEnd,
  type ReplayStreamStart,
} from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import { appendLivePause, applyLiveReplayExtensions, createLiveReplay, liveNote, livePose } from './live-replay';

// A recorded TournamentAssistant replay stream: a header, then every websocket
// frame of one play as [uint32 little-endian length][ReplayStreamPacket].
// v1 ("TAReplayStream v1") stores the frames exactly as TA sent them, so recording loses nothing.
// v2 ("TAReplayStream v2") is smaller: [uint32 LE packet section length][the v1 framing, with every
// chunk's poseFrames emptied], then a pose block of unsigned LEB128 varints to the end of the file:
// one pose frame count per packet, then 23 columns (time as float32 bits, fps, and head, left and
// right position xyz + rotation xyzw), each value zigzag delta-coded against the previous one in its
// column. Positions are quantized to 0.1 mm and rotations to 1/32767, everything else is exact.
export const TA_REPLAY_FILE_HEADER = new TextEncoder().encode('TAReplayStream v1\n');
const taReplayFileHeaderV2 = new TextEncoder().encode('TAReplayStream v2\n');

const maxReplayBytes = 128 * 1024 * 1024;
const maxFrameBytes = 4 * 1024 * 1024;

function hasHeader(data: Uint8Array, header: Uint8Array) {
  return data.byteLength >= header.byteLength && header.every((byte, index) => data[index] === byte);
}

export function isTaReplayFile(data: Uint8Array) {
  return hasHeader(data, TA_REPLAY_FILE_HEADER) || hasHeader(data, taReplayFileHeaderV2);
}

export function appendChunk(replay: Replay, chunk: ReplayChunk) {
  applyLiveReplayExtensions(replay, chunk.replayExtensions, true);
  const events = chunk.events;
  if (events === undefined) return;
  for (const event of events.pauseEvents) appendLivePause(replay, event);
  replay.poses.push(...events.poseFrames.map(livePose));
  replay.heights.push(...events.heightEvents.map((event) => ({ height: event.height, time: event.timeSeconds })));
  replay.notes.push(...events.noteEvents.map(liveNote));
  replay.scores.push(
    ...events.scoreEvents.map((event) => ({
      score: event.score,
      time: event.timeSeconds,
      immediateMaxPossibleScore: event.immediateMaxPossibleScore,
    })),
  );
  replay.combos.push(...events.comboEvents.map((event) => ({ combo: event.combo, time: event.timeSeconds })));
  replay.multipliers.push(
    ...events.multiplierEvents.map((event) => ({
      multiplier: event.multiplier,
      nextMultiplierProgress: event.nextMultiplierProgress,
      time: event.timeSeconds,
    })),
  );
  replay.energies.push(...events.energyEvents.map((event) => ({ energy: event.energy, time: event.timeSeconds })));
}

// Mirrors applyLiveReplayEnd: the end packet carries the final score and the fail time.
export function applyEnd(replay: Replay, end: ReplayStreamEnd, lastTime: number) {
  const time = Math.max(lastTime, Number(end.cursor?.songTimeMs ?? 0n) / 1000);
  if (end.completion === ReplayCompletion.FAILED) replay.metadata.failTime = time;
  if (end.score === undefined) return;
  replay.scores.push({
    score: end.score.modifiedScore || end.score.score,
    time,
    immediateMaxPossibleScore: end.score.maxScore || undefined,
  });
  replay.combos.push({ combo: end.score.combo, time });
}

function readFramedPackets(data: Uint8Array, view: DataView, start: number, end: number) {
  let offset = start;
  const packets: ReplayStreamPacket[] = [];
  while (offset < end) {
    if (offset + 4 > end) throw new Error('truncated TournamentAssistant replay file');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > maxFrameBytes || offset + length > end) {
      throw new Error('truncated TournamentAssistant replay file');
    }
    packets.push(fromBinary(ReplayStreamPacketSchema, data.subarray(offset, offset + length)));
    offset += length;
  }
  return packets;
}

const poseColumnCount = 23;

// Fills the emptied pose frames of a v2 file's chunks from the pose block that starts at `offset`.
function readPoseBlock(data: Uint8Array, offset: number, packets: ReplayStreamPacket[]) {
  // Unsigned LEB128 by arithmetic: values can exceed 32 bits, so no bit shifts.
  const readVarint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = data[offset++];
      if (byte === undefined) throw new Error('truncated TournamentAssistant replay file');
      value += (byte & 127) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
  };

  const counts = packets.map(readVarint);
  const total = counts.reduce((sum, count) => sum + count, 0);
  // Every value takes at least one byte, which also bounds the allocation below.
  if (total * poseColumnCount > data.byteLength - offset) throw new Error('truncated TournamentAssistant replay file');
  const columns = new Float64Array(poseColumnCount * total);
  for (let column = 0; column < poseColumnCount; column++) {
    let previous = 0;
    for (let index = 0; index < total; index++) {
      const zigzag = readVarint();
      previous += zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
      columns[column * total + index] = previous;
    }
  }

  const value = (column: number, index: number) => columns[column * total + index] ?? 0;
  const timeView = new DataView(new ArrayBuffer(4));
  const pose = (index: number, first: number) => ({
    position: {
      x: value(first, index) / 10000,
      y: value(first + 1, index) / 10000,
      z: value(first + 2, index) / 10000,
    },
    rotation: {
      x: value(first + 3, index) / 32767,
      y: value(first + 4, index) / 32767,
      z: value(first + 5, index) / 32767,
      w: value(first + 6, index) / 32767,
    },
  });
  let index = 0;
  packets.forEach((packet, packetIndex) => {
    const count = counts[packetIndex] ?? 0;
    if (count === 0) return;
    const events = packet.body.case === 'chunk' ? packet.body.value.events : undefined;
    if (events === undefined) throw new Error('truncated TournamentAssistant replay file');
    for (const end = index + count; index < end; index++) {
      timeView.setUint32(0, value(0, index));
      events.poseFrames.push(
        create(ReplayPoseFrameSchema, {
          timeSeconds: timeView.getFloat32(0),
          fps: value(1, index),
          head: pose(index, 2),
          left: pose(index, 9),
          right: pose(index, 16),
        }),
      );
    }
  });
}

/** Every frame of a TournamentAssistant replay file, in stored order. */
export function readTaReplayFilePackets(data: Uint8Array): ReplayStreamPacket[] {
  if (!isTaReplayFile(data)) throw new Error('not a TournamentAssistant replay file');
  if (data.byteLength > maxReplayBytes) throw new Error('TournamentAssistant replay file is too large');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = TA_REPLAY_FILE_HEADER.byteLength;
  if (hasHeader(data, TA_REPLAY_FILE_HEADER)) return readFramedPackets(data, view, headerLength, data.byteLength);

  if (headerLength + 4 > data.byteLength) throw new Error('truncated TournamentAssistant replay file');
  const sectionEnd = headerLength + 4 + view.getUint32(headerLength, true);
  if (sectionEnd > data.byteLength) throw new Error('truncated TournamentAssistant replay file');
  const packets = readFramedPackets(data, view, headerLength + 4, sectionEnd);
  readPoseBlock(data, sectionEnd, packets);
  return packets;
}

export function parseTaReplayFile(data: Uint8Array): Replay {
  let start: ReplayStreamStart | undefined;
  let streamId = '';
  let end: ReplayStreamEnd | undefined;
  const chunks: ReplayChunk[] = [];

  for (const packet of readTaReplayFilePackets(data)) {
    // A file holds one play. Frames of any other stream are ignored.
    if (packet.body.case === 'start' && start === undefined) {
      start = packet.body.value;
      streamId = packet.streamId;
    } else if (start === undefined || packet.streamId !== streamId) {
      continue;
    } else if (packet.body.case === 'chunk') {
      chunks.push(packet.body.value);
    } else if (packet.body.case === 'end') {
      end = packet.body.value;
    }
  }
  if (start === undefined) throw new Error('TournamentAssistant replay file has no start packet');

  // Frames are recorded in arrival order; the cursor restores send order.
  chunks.sort((left, right) => Number((left.cursor?.sequence ?? 0n) - (right.cursor?.sequence ?? 0n)));
  const replay = createLiveReplay(start, true);
  for (const chunk of chunks) appendChunk(replay, chunk);
  if (end !== undefined) applyEnd(replay, end, replay.poses.at(-1)?.time ?? 0);
  return replay;
}
