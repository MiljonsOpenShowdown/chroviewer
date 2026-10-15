const channelName = 'chroviewer:ta-live-sync:v1';
const storageKey = '__chroviewer_ta_live_sync_v1__';
const presenceIntervalMs = 200;
const peerTimeoutMs = 1500;
const syncToleranceSeconds = 0.025;
const driftToleranceSeconds = 0.04;

export interface TaLiveSyncSnapshot {
  currentTime: number;
  firstFrameTime: number;
  latestFrameTime: number;
  mapHash: string;
  playbackRate: number;
  playing: boolean;
  ready: boolean;
  streamId: string;
}

export interface TaLiveSyncActions {
  pause(): void;
  resume(): boolean;
  seek(time: number): void;
  correctDrift(time: number): void;
  setHolding(holding: boolean): void;
  updateStatus(status: 'buffering' | 'watching'): void;
}

interface PresenceMessage extends TaLiveSyncSnapshot {
  instanceId: string;
  joinedAt: number;
  platformId: string;
  sentAt: number;
  type: 'presence';
}

interface SyncMessage {
  coordinatorId: string;
  directiveId: string;
  mapHash: string;
  memberIds: string[];
  playAt: number;
  targetTime: number;
  type: 'sync';
}

type SyncWireMessage = PresenceMessage | SyncMessage;

interface PeerPresence {
  message: PresenceMessage;
  receivedAt: number;
}

interface SyncBus {
  send(message: SyncWireMessage): void;
  dispose(): void;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validPresence(value: unknown): value is PresenceMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<PresenceMessage>;
  return (
    message.type === 'presence' &&
    typeof message.instanceId === 'string' &&
    message.instanceId.length <= 128 &&
    typeof message.platformId === 'string' &&
    message.platformId.length <= 128 &&
    typeof message.mapHash === 'string' &&
    message.mapHash.length <= 64 &&
    typeof message.streamId === 'string' &&
    message.streamId.length <= 128 &&
    typeof message.playing === 'boolean' &&
    typeof message.ready === 'boolean' &&
    finite(message.currentTime) &&
    finite(message.firstFrameTime) &&
    finite(message.latestFrameTime) &&
    finite(message.playbackRate) &&
    finite(message.joinedAt) &&
    finite(message.sentAt)
  );
}

function validSync(value: unknown): value is SyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<SyncMessage>;
  return (
    message.type === 'sync' &&
    typeof message.coordinatorId === 'string' &&
    typeof message.directiveId === 'string' &&
    typeof message.mapHash === 'string' &&
    Array.isArray(message.memberIds) &&
    message.memberIds.length <= 32 &&
    message.memberIds.every((id) => typeof id === 'string' && id.length <= 128) &&
    finite(message.playAt) &&
    finite(message.targetTime)
  );
}

function createSyncBus(onMessage: (message: SyncWireMessage) => void): SyncBus {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(channelName);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (validPresence(event.data) || validSync(event.data)) onMessage(event.data);
    };
    return {
      send(message) {
        channel.postMessage(message);
      },
      dispose() {
        channel.close();
      },
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey || event.newValue === null) return;
    try {
      const message: unknown = JSON.parse(event.newValue);
      if (validPresence(message) || validSync(message)) onMessage(message);
    } catch {
      // Ignore unrelated or malformed same-origin storage values.
    }
  };
  window.addEventListener('storage', onStorage);
  return {
    send(message) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ ...message, nonce: crypto.randomUUID() }));
        localStorage.removeItem(storageKey);
      } catch {
        // Storage can be unavailable in privacy-restricted iframe contexts.
      }
    },
    dispose() {
      window.removeEventListener('storage', onStorage);
    },
  };
}

function comparePresence(left: PresenceMessage, right: PresenceMessage) {
  return left.joinedAt - right.joinedAt || left.instanceId.localeCompare(right.instanceId);
}

export function chooseTaLiveSyncTarget(members: PresenceMessage[]) {
  const ready = members.filter((member) => member.ready);
  if (ready.length === 0) return 0;
  const commonFirstFrame = Math.max(...ready.map((member) => member.firstFrameTime));
  const earliestCurrentTime = Math.min(...ready.map((member) => member.currentTime));
  return Math.max(commonFirstFrame, earliestCurrentTime);
}

export function createTaLiveSync(platformId: string) {
  const instanceId = crypto.randomUUID();
  const peers = new Map<string, PeerPresence>();
  let joinedAt = Date.now();
  let lastMapHash = '';
  let lastPresenceAt = 0;
  let knownMemberIds = new Set<string>();
  let pendingSync: SyncMessage | null = null;
  let lastDirectiveId = '';
  let latestSnapshot: TaLiveSyncSnapshot | null = null;

  const bus = createSyncBus((message) => {
    if (message.type === 'presence') {
      if (message.instanceId !== instanceId) peers.set(message.instanceId, { message, receivedAt: Date.now() });
      return;
    }
    if (
      latestSnapshot !== null &&
      message.mapHash === latestSnapshot.mapHash &&
      message.memberIds.includes(instanceId) &&
      message.directiveId !== lastDirectiveId
    ) {
      pendingSync = message;
      lastDirectiveId = message.directiveId;
    }
  });

  function localPresence(snapshot: TaLiveSyncSnapshot, now: number): PresenceMessage {
    return { ...snapshot, instanceId, joinedAt, platformId, sentAt: now, type: 'presence' };
  }

  function activeMembers(snapshot: TaLiveSyncSnapshot, now: number) {
    const members = [localPresence(snapshot, now)];
    for (const [peerId, peer] of peers) {
      if (now - peer.receivedAt > peerTimeoutMs) {
        peers.delete(peerId);
        continue;
      }
      if (peer.message.mapHash === snapshot.mapHash && peer.message.ready) members.push(peer.message);
    }
    return members.sort(comparePresence);
  }

  function coordinateNewMembers(snapshot: TaLiveSyncSnapshot, members: PresenceMessage[], now: number) {
    const memberIds = new Set(members.map((member) => member.instanceId));
    const added = [...memberIds].some((id) => !knownMemberIds.has(id));
    knownMemberIds = memberIds;
    if (!snapshot.ready || members.length < 2 || members[0]?.instanceId !== instanceId || !added) return;

    const targetTime = chooseTaLiveSyncTarget(members);
    const catchupSeconds = Math.max(
      0,
      ...members.map((member) =>
        member.currentTime >= targetTime ? 0 : (targetTime - member.currentTime) / Math.max(0.01, member.playbackRate),
      ),
    );
    const directive: SyncMessage = {
      coordinatorId: instanceId,
      directiveId: crypto.randomUUID(),
      mapHash: snapshot.mapHash,
      memberIds: [...memberIds].sort(),
      playAt: now + Math.max(350, catchupSeconds * 1000 + 250),
      targetTime,
      type: 'sync',
    };
    pendingSync = directive;
    lastDirectiveId = directive.directiveId;
    bus.send(directive);
  }

  function applyPendingSync(snapshot: TaLiveSyncSnapshot, actions: TaLiveSyncActions, now: number) {
    const directive = pendingSync;
    if (directive?.mapHash !== snapshot.mapHash) return false;
    const currentTime = snapshot.currentTime;
    actions.setHolding(now < directive.playAt);

    if (now < directive.playAt) {
      actions.updateStatus('buffering');
      if (currentTime > directive.targetTime + syncToleranceSeconds) {
        actions.seek(directive.targetTime);
        actions.pause();
      } else if (currentTime < directive.targetTime - syncToleranceSeconds) {
        actions.resume();
      } else {
        if (Math.abs(currentTime - directive.targetTime) > 0.01) actions.seek(directive.targetTime);
        actions.pause();
      }
      return true;
    }

    const expectedTime = directive.targetTime + ((now - directive.playAt) / 1000) * snapshot.playbackRate;
    actions.setHolding(false);
    if (Math.abs(currentTime - expectedTime) > syncToleranceSeconds) actions.seek(expectedTime);
    actions.resume();
    actions.updateStatus('watching');
    if (now - directive.playAt > 1000) pendingSync = null;
    return true;
  }

  function correctFollowerDrift(
    snapshot: TaLiveSyncSnapshot,
    members: PresenceMessage[],
    actions: TaLiveSyncActions,
    now: number,
  ) {
    const coordinator = members[0];
    if (
      coordinator === undefined ||
      coordinator.instanceId === instanceId ||
      !coordinator.playing ||
      !snapshot.playing
    ) {
      return;
    }
    const estimatedCoordinatorTime =
      coordinator.currentTime + ((now - coordinator.sentAt) / 1000) * coordinator.playbackRate;
    actions.correctDrift(
      Math.abs(snapshot.currentTime - estimatedCoordinatorTime) > driftToleranceSeconds
        ? estimatedCoordinatorTime
        : snapshot.currentTime,
    );
  }

  return {
    tick(snapshot: TaLiveSyncSnapshot | null, actions: TaLiveSyncActions) {
      latestSnapshot = snapshot;
      const now = Date.now();
      if (snapshot === null || snapshot.mapHash === '') {
        pendingSync = null;
        knownMemberIds.clear();
        actions.setHolding(false);
        return;
      }
      if (snapshot.mapHash !== lastMapHash) {
        lastMapHash = snapshot.mapHash;
        joinedAt = now;
        pendingSync = null;
        knownMemberIds = new Set([instanceId]);
      }
      if (now - lastPresenceAt >= presenceIntervalMs) {
        lastPresenceAt = now;
        bus.send(localPresence(snapshot, now));
      }
      const members = activeMembers(snapshot, now);
      coordinateNewMembers(snapshot, members, now);
      if (applyPendingSync(snapshot, actions, now)) return;
      actions.setHolding(false);
      correctFollowerDrift(snapshot, members, actions, now);
    },
    dispose() {
      latestSnapshot = null;
      bus.dispose();
    },
  };
}
