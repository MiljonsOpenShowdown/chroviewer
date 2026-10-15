import { fromBinary } from '@bufbuild/protobuf';

import type { Replay } from '../../core/replay/types';
import {
  ReplayCompletion,
  ReplayStreamPacketSchema,
  type ReplayChunk,
  type ReplayStreamEnd,
  type ReplayStreamStart,
} from './generated/proto/scoresaber/live/v1/replay_stream_pb';
import { appendLivePause, applyLiveReplayExtensions, createLiveReplay, liveNote, livePose } from './live-replay';

// A recorded TournamentAssistant replay stream: this header, followed by every
// websocket frame of one play as [uint32 little-endian length][ReplayStreamPacket].
// The frames are stored exactly as TA sent them, so recording loses nothing.
export const TA_REPLAY_FILE_HEADER = new TextEncoder().encode('TAReplayStream v1\n');

const maxReplayBytes = 128 * 1024 * 1024;
const maxFrameBytes = 4 * 1024 * 1024;

export function isTaReplayFile(data: Uint8Array) {
  return (
    data.byteLength >= TA_REPLAY_FILE_HEADER.byteLength &&
    TA_REPLAY_FILE_HEADER.every((byte, index) => data[index] === byte)
  );
}

function appendChunk(replay: Replay, chunk: ReplayChunk) {
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
function applyEnd(replay: Replay, end: ReplayStreamEnd, lastTime: number) {
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

export function parseTaReplayFile(data: Uint8Array): Replay {
  if (!isTaReplayFile(data)) throw new Error('not a TournamentAssistant replay file');
  if (data.byteLength > maxReplayBytes) throw new Error('TournamentAssistant replay file is too large');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = TA_REPLAY_FILE_HEADER.byteLength;
  let start: ReplayStreamStart | undefined;
  let streamId = '';
  let end: ReplayStreamEnd | undefined;
  const chunks: ReplayChunk[] = [];

  while (offset < data.byteLength) {
    if (offset + 4 > data.byteLength) throw new Error('truncated TournamentAssistant replay file');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > maxFrameBytes || offset + length > data.byteLength) {
      throw new Error('truncated TournamentAssistant replay file');
    }
    const packet = fromBinary(ReplayStreamPacketSchema, data.subarray(offset, offset + length));
    offset += length;
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
