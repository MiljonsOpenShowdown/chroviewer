import { afterEach, describe, expect, test, vi } from 'vite-plus/test';

import {
  compositorSyncSettings,
  MultiviewStartBarrier,
  type BufferedStartParticipant,
} from './multiview-start-barrier';

const roster = (count = 8) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${index}`,
    playerId: `player-${index}`,
    visible: true,
    settings: { compositorSyncType: 'wait-for-all', compositorWaitSeconds: 30 },
  }));
const participant = (changes: Partial<BufferedStartParticipant> = {}): BufferedStartParticipant => ({
  ready: true,
  firstFrameTime: 0,
  latestFrameTime: 2,
  playbackRate: 1,
  start: vi.fn(),
  ...changes,
});

afterEach(() => vi.useRealTimers());

describe('buffered compositor startup', () => {
  test('starts eight POVs exactly once in one task with a common timeline', () => {
    vi.useFakeTimers();
    const barrier = new MultiviewStartBarrier(() => 12_345);
    barrier.configure(roster());
    const members = roster().map((player, index) => {
      const member = participant({ firstFrameTime: index / 100 });
      barrier.begin(player.id, `stream-${index}`, 'same-map:9:Standard:1');
      expect(barrier.update(player.id, `stream-${index}`, { ...member, ready: false })).toBe(true);
      return member;
    });
    members.slice(0, 7).forEach((member, index) => {
      expect(barrier.update(`${index}`, `stream-${index}`, member)).toBe(true);
      expect(member.start).not.toHaveBeenCalled();
    });
    expect(barrier.update('7', 'stream-7', members[7] as BufferedStartParticipant)).toBe(false);
    members.forEach((member) => expect(member.start).toHaveBeenCalledExactlyOnceWith(0.07, 12_345));
    expect(vi.getTimerCount()).toBe(0);
    // Packet and clock ticks during playback never seek, restart or create timers.
    for (let tick = 0; tick < 600; tick++) {
      members.forEach((member, index) => expect(barrier.update(`${index}`, `stream-${index}`, member)).toBe(false));
    }
    members.forEach((member) => expect(member.start).toHaveBeenCalledTimes(1));
    barrier.dispose();
  });

  test('requires agreement from every visible POV and bounds the shortest deadline', () => {
    const players = roster(2);
    const [first, second] = players;
    if (first === undefined || second === undefined) throw new Error('missing players');
    expect(compositorSyncSettings(players)).toEqual({ type: 'wait-for-all', waitSeconds: 30 });
    first.settings.compositorWaitSeconds = 90;
    second.settings.compositorWaitSeconds = 60;
    expect(compositorSyncSettings(players).waitSeconds).toBe(60);
    second.settings.compositorSyncType = 'slow';
    expect(compositorSyncSettings(players).type).toBe('slow');
    second.visible = false;
    expect(compositorSyncSettings(players).type).toBe('wait-for-all');
    expect(compositorSyncSettings([{ ...first, settings: {} }]).type).toBe('slow');
    expect(compositorSyncSettings([]).type).toBe('slow');
    expect(
      compositorSyncSettings([
        { ...first, settings: { compositorSyncType: 'wait-for-all', compositorWaitSeconds: -1 } },
      ]).waitSeconds,
    ).toBe(1);
  });

  test('missing players time out without repeatedly holding a late player', () => {
    vi.useFakeTimers();
    const barrier = new MultiviewStartBarrier();
    barrier.configure(roster(2));
    barrier.begin('0', 'early', 'map');
    const early = participant();
    expect(barrier.update('0', 'early', early)).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(barrier.isWaitingFor('0', 'early')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(barrier.update('0', 'early', early)).toBe(false);
    barrier.begin('1', 'late', 'map');
    expect(barrier.update('1', 'late', participant())).toBe(false);
    expect(early.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    barrier.dispose();
  });

  test.each(['different-map', 'map:7:Standard:1', 'map:9:OneSaber:1'])(
    'incompatible map identity %s falls back immediately',
    (otherMap) => {
      vi.useFakeTimers();
      const barrier = new MultiviewStartBarrier();
      barrier.configure(roster(2));
      barrier.begin('0', 'one', 'map:9:Standard:1');
      barrier.begin('1', 'two', otherMap);
      expect(barrier.isWaitingFor('0', 'one')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      barrier.dispose();
    },
  );

  test('incompatible clocks fall back without seeking', () => {
    const changes = { playbackRate: 1.2 };
    vi.useFakeTimers();
    const barrier = new MultiviewStartBarrier();
    barrier.configure(roster(2));
    const first = participant();
    const second = participant(changes);
    barrier.begin('0', 'one', 'map');
    barrier.begin('1', 'two', 'map');
    barrier.update('0', 'one', first);
    expect(barrier.update('1', 'two', second)).toBe(false);
    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    barrier.dispose();
  });

  test('a late first frame waits until every stream has enough data at the common start', () => {
    vi.useFakeTimers();
    const barrier = new MultiviewStartBarrier();
    barrier.configure(roster(2));
    const first = participant({ minimumBufferSeconds: 1 });
    const second = participant({ firstFrameTime: 5, latestFrameTime: 7, minimumBufferSeconds: 1 });
    barrier.begin('0', 'one', 'map');
    barrier.begin('1', 'two', 'map');
    barrier.update('0', 'one', first);
    expect(barrier.update('1', 'two', second)).toBe(true);
    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    expect(barrier.update('0', 'one', { ...first, latestFrameTime: 5.5 })).toBe(true);
    expect(barrier.update('0', 'one', { ...first, latestFrameTime: 6 })).toBe(false);
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    barrier.dispose();
  });

  test('a second round on the same map waits for fresh streams from both players', () => {
    vi.useFakeTimers();
    const barrier = new MultiviewStartBarrier();
    barrier.configure(roster(2));
    for (const round of [1, 2]) {
      const first = participant();
      const second = participant();
      barrier.begin('0', `one-${round}`, 'map');
      expect(barrier.update('0', `one-${round}`, first)).toBe(true);
      expect(first.start).not.toHaveBeenCalled();
      barrier.begin('1', `two-${round}`, 'map');
      barrier.update('1', `two-${round}`, second);
      expect(first.start).toHaveBeenCalledTimes(1);
      expect(second.start).toHaveBeenCalledTimes(1);
    }
    barrier.dispose();
  });

  test('color updates preserve a wait; changed membership or sync type cancels it', () => {
    vi.useFakeTimers();
    const players = roster(2);
    const barrier = new MultiviewStartBarrier();
    barrier.configure(players);
    barrier.begin('0', 'one', 'map');
    barrier.configure(players.map((player) => ({ ...player, settings: { ...player.settings, leftColor: '#123456' } })));
    expect(barrier.isWaitingFor('0', 'one')).toBe(true);
    barrier.configure(players.slice(0, 1));
    expect(barrier.isWaitingFor('0', 'one')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    barrier.begin('0', 'new', 'map');
    barrier.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
