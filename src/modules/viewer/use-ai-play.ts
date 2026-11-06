import { useEffect, useRef, useState } from 'react';

import { fromBinary } from '@bufbuild/protobuf';

import { effectiveNoteJumpSpeed } from '../../core/beatmap/info';
import type { Replay } from '../../core/replay/types';
import { DEFAULT_PLAYER_HEIGHT } from '../ai/ai-generate';
import { AI_DIFFICULTY_RANKS, aiMapData } from '../ai/ai-map';
import {
  AI_MODEL_BASE,
  AI_PLAYER_ID,
  type AiPlayerIndex,
  type FromAiWorker,
  type ToAiWorker,
} from '../ai/ai-worker-protocol';
import { ReplayStreamPacketSchema } from '../live/generated/proto/scoresaber/live/v1/replay_stream_pb';
import { createLiveReplay } from '../live/live-replay';
import { appendChunk, applyEnd } from '../live/ta-replay-file';
import type { useSongTransport } from './use-song-transport';
import type { useViewerSession } from './use-viewer-session';
import type { useViewerSources } from './use-viewer-sources';

// "AI Play" runs the built-in AI (src/modules/ai) entirely in the browser. It
// needs the model files in public/ai; this checks once whether they are there.

export type AiModelAvailability = 'checking' | 'available' | 'missing';

export function useAiModelAvailability() {
  const [availability, setAvailability] = useState<AiModelAvailability>('checking');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${AI_MODEL_BASE}/model.onnx`, { method: 'HEAD', cache: 'no-cache', signal: controller.signal })
      .then((response) => {
        setAvailability(response.ok ? 'available' : 'missing');
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailability('missing');
      });
    return () => {
      controller.abort();
    };
  }, []);
  return availability;
}

/** Player-picker value for the AI itself (Radix Select items can't use ''). */
export const AI_PLAYER_CHOICE = 'ai';

/** A player fork exported to public/ai/players: it plays the map as that player. */
export interface AiPlayerOption {
  id: string;
  name: string;
  height: number;
}

/** The exported player forks (public/ai/players/index.json); empty when there are none. */
export function useAiPlayers() {
  const [players, setPlayers] = useState<AiPlayerOption[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${AI_MODEL_BASE}/players/index.json`, { cache: 'no-cache', signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<AiPlayerIndex>) : null))
      .then((index) => {
        const entries = Object.entries(index?.players ?? {});
        setPlayers(
          entries
            .flatMap(([id, entry]) => (entry === undefined ? [] : [{ id, name: entry.name, height: entry.height }]))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch(() => {
        // no players folder: only the AI plays
      });
    return () => {
      controller.abort();
    };
  }, []);
  return players;
}

type Sources = ReturnType<typeof useViewerSources>;
type Session = ReturnType<typeof useViewerSession>;
type Transport = ReturnType<typeof useSongTransport>;

export interface AiPlayTarget {
  difficulty: 'Easy' | 'Normal' | 'Hard' | 'Expert' | 'ExpertPlus';
  characteristic: string;
}

interface AiPreviewRun {
  worker: Worker;
  hash: string;
  target: AiPlayTarget;
  replay: Replay | null;
  /** Chunks wait here until the map is rendered, so none are lost while it loads. */
  queued: Uint8Array[];
  mapLoaded: boolean;
  viewReady: boolean;
  /** Song time up to which the AI's play is generated. */
  edge: number;
  finished: boolean;
  started: boolean;
  /** Paused by the generation edge (not the user), so it resumes by itself. */
  held: boolean;
}

/** Generated seconds ahead of the playhead before AI Play starts or resumes. */
const LEAD_SECONDS = 3;

// AI Play in the regular map preview: the worker generates the play as fast as
// it can, and its chunks grow a normal replay of the loaded map. Playback
// starts once a few seconds are generated and waits at the generation edge.
// autoStart (map= plus aiDiff in the URL) starts it once the map is loaded.
export function useAiPreview(options: {
  sources: Sources;
  session: Session;
  transport: Transport;
  setError: (message: string) => void;
  autoStart?: AiPlayTarget;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const runRef = useRef<AiPreviewRun | null>(null);
  const autoStartedRef = useRef(false);
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);
  // Whether this map's specialist model plays (public/ai/specialists) instead of model.onnx.
  const [specialist, setSpecialist] = useState(false);

  function pending(target: AiPlayTarget) {
    return { difficultyRank: AI_DIFFICULTY_RANKS[target.difficulty], characteristic: target.characteristic };
  }

  function end(run: AiPreviewRun) {
    run.worker.terminate();
    if (runRef.current !== run) return;
    runRef.current = null;
    setActive(false);
    setProgress(0);
    setSpecialist(false);
  }

  function fail(run: AiPreviewRun, message: string) {
    if (runRef.current !== run) return;
    optionsRef.current.setError(message);
    end(run);
  }

  function applyPacket(run: AiPreviewRun, bytes: Uint8Array) {
    const replay = run.replay;
    if (replay === null) return;
    const packet = fromBinary(ReplayStreamPacketSchema, bytes);
    if (packet.body.case === 'end') {
      applyEnd(replay, packet.body.value, replay.poses.at(-1)?.time ?? 0);
      run.finished = true;
      run.worker.terminate();
      return;
    }
    if (packet.body.case !== 'chunk') return;
    const notes = replay.notes.length;
    const heights = replay.heights.length;
    appendChunk(replay, packet.body.value);
    const { session } = optionsRef.current;
    session.appendLiveReplayHeightEvents(replay.heights.slice(heights));
    session.appendLiveReplayNoteEvents(replay.notes.slice(notes));
    run.edge = replay.poses.at(-1)?.time ?? run.edge;
  }

  function receive(run: AiPreviewRun, bytes: Uint8Array) {
    if (run.replay !== null) {
      if (run.viewReady) applyPacket(run, bytes);
      else run.queued.push(bytes);
      return;
    }
    const packet = fromBinary(ReplayStreamPacketSchema, bytes);
    if (packet.body.case !== 'start') return;
    const replay = createLiveReplay(packet.body.value);
    run.replay = replay;
    void optionsRef.current.sources.loadAiPreview(run.hash, replay, pending(run.target)).then((result) => {
      if (result.isErr()) fail(run, result.error.message);
      else run.mapLoaded = true;
    });
  }

  /** player: one of useAiPlayers' forks plays instead of the AI, from its own starting clip and at its height. */
  async function start(target: AiPlayTarget, player?: AiPlayerOption) {
    const { sources, session, transport } = optionsRef.current;
    const row = sources.rows.find((candidate) => candidate.key === session.selectedKey);
    if (runRef.current !== null || row?.difficulty === undefined || row.infoDifficulty === undefined) return;
    transport.pause();
    const hash = await sources.aiMapHash();
    if (hash === null || runRef.current !== null) return;
    const data = aiMapData(row.difficulty, sources.songBpm, {
      hash,
      ...target,
      njs: effectiveNoteJumpSpeed(row.infoDifficulty),
    });
    const worker = new Worker(new URL('../ai/ai-worker.ts', import.meta.url), { type: 'module' });
    const run: AiPreviewRun = {
      worker,
      hash,
      target,
      replay: null,
      queued: [],
      mapLoaded: false,
      viewReady: false,
      edge: 0,
      finished: false,
      started: false,
      held: false,
    };
    runRef.current = run;
    setActive(true);
    setProgress(0);
    worker.onmessage = (event: MessageEvent<FromAiWorker>) => {
      if (runRef.current !== run) return;
      const message = event.data;
      if (message.type === 'packet') receive(run, new Uint8Array(message.bytes));
      else if (message.type === 'error') fail(run, `AI Play failed: ${message.message}`);
      else if (message.model !== undefined) setSpecialist(message.model === 'specialist');
      else if (message.generatedSeconds !== undefined && message.songSeconds) {
        setProgress(Math.min(100, Math.floor((message.generatedSeconds / message.songSeconds) * 100)));
      }
    };
    worker.onerror = (event) => {
      fail(run, `AI Play failed: ${event.message}`);
    };
    const startMessage: ToAiWorker = {
      type: 'start',
      streamId: crypto.randomUUID(),
      playerId: AI_PLAYER_ID,
      mapHash: hash,
      difficulty: target.difficulty,
      difficultyRank: AI_DIFFICULTY_RANKS[target.difficulty] ?? 9,
      characteristic: target.characteristic,
      modelBase: AI_MODEL_BASE,
      ...(player !== undefined && { player: player.id }),
      height: player?.height ?? DEFAULT_PLAYER_HEIGHT,
      ...(transport.duration > 0 && { songSeconds: transport.duration }),
    };
    worker.postMessage(startMessage);
    worker.postMessage({ type: 'map', data } satisfies ToAiWorker);
  }

  /** Stops the AI and shows the map without its play. */
  function stop() {
    const run = runRef.current;
    if (run === null) return;
    optionsRef.current.transport.pause();
    end(run);
    void optionsRef.current.sources.loadAiPreview(run.hash, null, pending(run.target)).then((result) => {
      if (result.isErr()) optionsRef.current.setError(result.error.message);
    });
  }

  // The map is rendered once its difficulty is selected; leaving it (another
  // map, the back button) ends AI Play.
  const selectedKey = options.session.selectedKey;
  useEffect(() => {
    const run = runRef.current;
    if (run === null || !run.mapLoaded) return;
    if (selectedKey === '') {
      if (run.viewReady) end(run);
      return;
    }
    run.viewReady = true;
    for (const bytes of run.queued) applyPacket(run, bytes);
    run.queued = [];
  }, [selectedKey]);

  // autoStart: once the URL's map shows a difficulty, switch to the requested
  // one, then start the AI on it. Only once per page.
  const rows = options.sources.rows;
  useEffect(() => {
    const target = optionsRef.current.autoStart;
    const { sources, session } = optionsRef.current;
    if (target === undefined || autoStartedRef.current || runRef.current !== null) return;
    if (selectedKey === '' || sources.replayRef.current !== null) return;
    const characteristic = target.characteristic.toLowerCase();
    const row = rows.find(
      (candidate) =>
        candidate.difficulty !== undefined &&
        candidate.infoDifficulty?.difficulty === target.difficulty &&
        candidate.infoDifficulty.characteristic.toLowerCase() === characteristic,
    );
    if (row === undefined) return;
    if (row.key !== selectedKey) {
      void session.selectDifficulty(row);
      return;
    }
    autoStartedRef.current = true;
    void start(target);
  }, [selectedKey, rows]);

  // Starts playback once LEAD_SECONDS are generated and holds it at the edge.
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      const run = runRef.current;
      const { transport } = optionsRef.current;
      const clock = transport.clockRef.current;
      if (run === null || !run.viewReady || clock === null) return;
      const edge = run.finished ? Number.POSITIVE_INFINITY : run.edge;
      const now = clock.currentTime();
      if (!run.started || run.held) {
        if (edge - now < LEAD_SECONDS) return;
        run.started = true;
        run.held = false;
        transport.play({ autoplay: true });
      } else if (clock.isPlaying() && now >= edge) {
        run.held = true;
        transport.pause();
      }
    }, 100);
    return () => {
      window.clearInterval(interval);
    };
  }, [active]);

  useEffect(
    () => () => {
      runRef.current?.worker.terminate();
    },
    [],
  );

  return { active, progress, specialist, start, stop };
}
