export interface EmbeddedRealtimeScore {
  [key: string]: unknown;
  songPosition?: number;
}

export interface EmbeddedRealtimeScoreMessage {
  type: 'beatkhana:realtime-score';
  version: 1;
  playerId: string;
  platformIds: string[];
  score: EmbeddedRealtimeScore;
  sentAt: number;
}

interface CachedScore {
  position: number;
  score: EmbeddedRealtimeScore;
  signature: string;
}

const maximumCachedScores = 1200;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizePlayerId(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : '';
}

export function isEmbeddedRealtimeScoreMessage(
  value: unknown,
  expectedPlayerId: string,
): value is EmbeddedRealtimeScoreMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<EmbeddedRealtimeScoreMessage>;
  if (
    message.type !== 'beatkhana:realtime-score' ||
    message.version !== 1 ||
    typeof message.playerId !== 'string' ||
    !Array.isArray(message.platformIds) ||
    typeof message.score !== 'object' ||
    message.score === null ||
    !finite(message.sentAt)
  ) {
    return false;
  }
  const expected = normalizePlayerId(expectedPlayerId);
  return (
    expected.length > 0 &&
    [message.playerId, ...message.platformIds].some((identifier) => normalizePlayerId(identifier) === expected)
  );
}

export class EmbeddedRealtimeScoreTimeline {
  private scores: CachedScore[] = [];
  private lastPosition = -Infinity;

  add(score: EmbeddedRealtimeScore) {
    const position = Number(score.songPosition);
    if (!Number.isFinite(position) || position < 0) return false;
    if (position + 2 < this.lastPosition) this.clear();
    this.lastPosition = position;
    const signature = JSON.stringify(score);
    const previous = this.scores.at(-1);
    if (previous?.position === position && previous.signature === signature) return false;
    this.scores.push({ position, score, signature });
    if (this.scores.length > maximumCachedScores) {
      this.scores.splice(0, this.scores.length - maximumCachedScores);
    }
    return true;
  }

  at(time: number) {
    if (!Number.isFinite(time) || this.scores.length === 0) return null;
    let low = 0;
    let high = this.scores.length - 1;
    let match: CachedScore | null = null;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = this.scores[middle];
      if (candidate === undefined) break;
      if (candidate.position <= time + 0.025) {
        match = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return match;
  }

  clear() {
    this.scores = [];
    this.lastPosition = -Infinity;
  }

  get size() {
    return this.scores.length;
  }
}
