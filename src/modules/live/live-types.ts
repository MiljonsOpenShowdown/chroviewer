import type { RefObject } from 'react';

import type { SongClock } from '../../core/clock/song-clock';
import type { Replay, ReplayHeightEvent, ReplayNoteEvent } from '../../core/replay/types';
import type { ScoreSaberReplayPlayer, SourceResult } from '../../sources/source-types';
import type { AiMapData } from '../ai/ai-map';
import type { MultiviewStartBarrier } from '../multiview/multiview-start-barrier';
import type { LiveChatMessage } from './generated/proto/scoresaber/live/v1/chat_pb';
import type { LudusPlayState } from './generated/proto/scoresaber/live/v1/common_pb';

export type LiveStatus =
  | 'connecting'
  | 'waiting'
  | 'loading'
  | 'buffering'
  | 'watching'
  | 'paused'
  | 'reconnecting'
  | 'error';

export interface LiveTarget {
  playerId: string;
  source?: 'scoresaber' | 'ta' | 'cocu' | 'ai';
  /** liveSource=ai: the map the built-in AI plays (src/modules/ai). */
  ai?: { hash: string; difficulty: string; characteristic: string };
  tournamentId?: string;
  roomId?: string;
  matchId?: string;
  watcherPlayerId?: string;
  authToken?: string;
}

export interface LiveExperienceState {
  audioBlocked: boolean;
  canChat: boolean;
  chatError: boolean;
  messages: LiveChatMessage[];
  pendingChatMessageIds: string[];
  playState: LudusPlayState;
  status: LiveStatus;
  /** The TA replay stream (one play) being shown; '' before the first. */
  streamId: string;
  viewerCount: number | null;
}

export interface ChatExperience {
  audioBlocked: boolean;
  canChat: boolean;
  chatError: boolean;
  messages: LiveChatMessage[];
  pendingChatMessageIds: string[];
  sendChatMessage(text: string): boolean;
  unlockAudio(): Promise<boolean>;
}

export interface LiveExperience extends LiveExperienceState, ChatExperience {
  player: ScoreSaberReplayPlayer | null;
  playerProfilePending: boolean;
}

interface LiveTransport {
  clockRef: RefObject<SongClock | null>;
  play(options?: { autoplay?: boolean }): boolean | undefined;
  seek(time: number): void;
  togglePlay(): boolean | undefined;
}

export interface LiveExperienceOptions {
  appendReplayHeightEvents: (events: ReplayHeightEvent[]) => void;
  appendReplayNoteEvents: (events: ReplayNoteEvent[]) => void;
  refreshReplayDisplay: () => void;
  externalTimeline?: boolean;
  /** Limits TA live sync to viewers with the same group; unset syncs with every viewer on this origin. */
  taSyncGroup?: string;
  /**
   * A TournamentAssistant replay file of the play so far, applied before the
   * live socket's packets, so a viewer opened midway starts at the live edge.
   */
  taCatchupUrl?: string;
  startBarrier?: { id: string; barrier: MultiviewStartBarrier };
  hasLiveMap: (hash: string) => boolean;
  loadLiveReplay: (hash: string, replay: Replay) => Promise<SourceResult<void>>;
  selectedKey: string;
  /** Parsed map for the built-in AI once the live map has loaded (liveSource=ai). */
  aiMapData?: AiMapData | null;
  target: LiveTarget | null;
  transport: LiveTransport;
}
