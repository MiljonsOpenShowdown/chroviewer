import type { LiveTimelineEvent } from '../live/live-types';
import type { MultiviewTimelineEntry, MultiviewTimelineEvent } from './multiview-protocol';

/** Events per message at most; the rest are counted in a `dropped` event. */
const MAX_EVENTS = 100;
/** Console entries per message at most, so a warning loop cannot fill it. */
const MAX_CONSOLE = 10;
const MAX_MESSAGE_CHARS = 300;

interface ChunkSummary {
  playerId: string | null;
  at: number;
  count: number;
  frames: number;
  from: number;
  to: number;
  gaps: number;
}

/** Song times to the millisecond and texts cut short: the parent has no use for more. */
function compact<T extends object>(event: T): T {
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => {
      if (typeof value === 'number' && !Number.isInteger(value)) return [key, Math.round(value * 1000) / 1000];
      if (typeof value === 'string') return [key, value.slice(0, MAX_MESSAGE_CHARS)];
      return [key, value];
    }),
  ) as T;
}

/**
 * Collects the tiles' stream timelines between two MultiviewEventsMessages:
 * every event as it happened, except chunks, which are summed up per tile.
 */
export class MultiviewEventLog {
  private events: MultiviewTimelineEntry[] = [];
  private chunks = new Map<string, ChunkSummary>();
  private consoleCount = 0;
  private dropped = 0;

  add(
    tileId: string | null,
    playerId: string | null,
    event: LiveTimelineEvent | MultiviewTimelineEvent,
    at = Date.now(),
  ) {
    if (event.type === 'chunk') {
      if (tileId === null) return;
      const summary = this.chunks.get(tileId);
      if (summary === undefined) {
        this.chunks.set(tileId, {
          playerId,
          at,
          count: 1,
          frames: event.frames,
          from: event.songTime,
          to: event.songTime,
          gaps: event.gap,
        });
        return;
      }
      summary.at = at;
      summary.count++;
      summary.frames += event.frames;
      summary.to = event.songTime;
      summary.gaps += event.gap;
      return;
    }
    if (event.type === 'console' && ++this.consoleCount > MAX_CONSOLE) {
      this.dropped++;
      return;
    }
    if (this.events.length >= MAX_EVENTS) {
      this.dropped++;
      return;
    }
    const entry = event.type === 'seek' && !('reason' in event) ? { ...event, reason: 'live' as const } : event;
    this.events.push({ ...compact(entry), tileId, playerId, at });
  }

  /** Everything since the last take, oldest first; null when nothing happened. */
  take(at = Date.now()): MultiviewTimelineEntry[] | null {
    const events = this.events;
    for (const [tileId, { playerId, at: chunkAt, ...summary }] of this.chunks)
      events.push({ ...compact({ type: 'chunks' as const, ...summary }), tileId, playerId, at: chunkAt });
    if (this.dropped > 0) events.push({ type: 'dropped', count: this.dropped, tileId: null, playerId: null, at });
    this.events = [];
    this.chunks.clear();
    this.consoleCount = 0;
    this.dropped = 0;
    if (events.length === 0) return null;
    return events.sort((left, right) => left.at - right.at);
  }
}

function consoleText(args: unknown[]) {
  const text = args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  // URLs may carry keys in their query (an overlay's catch-up URL): never pass one on
  return text.replace(/\?[^\s'"`)]+/g, '?...').slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Passes the page's console warnings and errors, and its uncaught errors, to
 * `onEntry` as well. Returns the function that stops it.
 */
export function captureViewerConsole(onEntry: (level: 'warn' | 'error', message: string) => void) {
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args: unknown[]) => {
    onEntry('warn', consoleText(args));
    warn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    onEntry('error', consoleText(args));
    error.apply(console, args);
  };
  const uncaught = (event: ErrorEvent) => onEntry('error', consoleText([event.error ?? event.message]));
  const rejected = (event: PromiseRejectionEvent) => onEntry('error', consoleText([event.reason]));
  window.addEventListener('error', uncaught);
  window.addEventListener('unhandledrejection', rejected);
  return () => {
    console.warn = warn;
    console.error = error;
    window.removeEventListener('error', uncaught);
    window.removeEventListener('unhandledrejection', rejected);
  };
}
