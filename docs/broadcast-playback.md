# Broadcast replay playback

The BeatKhana scene owns one ChroViewer multiview iframe for its compatible
top-level replay tiles. Browser sources, Electron windows, and Spout all select
this path, including a scene with only one player. Nested, transformed, translucent,
and alternate-host tiles use the same multiview protocol in a local compositor
iframe so their DOM transforms, opacity, and clipping continue to work. Such
tiles still have separate contexts; the eight-player shared-renderer budget below
applies to players in the same compositor.

The iframe remains a deployed web application at `view.replay.beatkhana.com`.
The parent at `beatkhana.com` sends `beatkhana:multiview-config`; ChroViewer
validates the sender, player IDs, and configuration, and returns
`beatkhana:multiview-state` for overlay progress and delayed score consumers.
Local HTTP development and the alternate ChroViewer host remain supported.
No browser security headers or deployment topology were changed.

## Rendering and player isolation

`MultiviewRendererHost` owns one WebGL renderer and frame loop. Each player has
their own `MapView`, camera, replay, materials, colors, HSV configuration, and
render targets. Only map downloads, beatmap parsing, shader programs in the
shared WebGL context, and the output canvas are shared. Replay colors and HSV
profiles are selected independently for each player.

The render path is scene update, environment/fog capture, optional reflection,
scene target, bloom pyramid, and scissored tile composition. Fog and reflection
targets are explicitly cleared even when the shared renderer has automatic
clearing disabled. Unchanged fog output can be reused. Bloom targets are capped
to each player's actual render width rather than upscaling small tiles. Canvas
layout is measured on resize, rather than once per output frame.

Broadcast defaults live in `broadcastSettingsForPlayerCount`. Explicit player
settings override them; settings polling inside a multiview player cannot read
the common iframe URL and overwrite those player-specific values.

| Visible players | FPS target | Render scale | MSAA | Bloom width cap | Fog size | Trail samples |
| --------------- | ---------- | ------------ | ---- | --------------- | -------- | ------------- |
| 1–2             | 60         | 0.85         | 2    | 640             | 256      | 12            |
| 3–4             | 60         | 0.75         | 0    | 512             | 192      | 10            |
| 5–8 (also 9–12) | 60         | 0.65         | 0    | 384             | 128      | 8             |

Mirrors and screen displacement are disabled by default; lights default to
static in the overlay. The lowest explicit FPS cap among visible players governs
the shared canvas. One audible player owns song/hitsound processing; muted POVs
use silent clocks. Repeated static cosmetic extensions are cached by replay and
payload so a repeated HSV packet does not rebuild player cosmetics.

Spout retains Electron's shared GPU texture output and the existing D3D11 bridge.
It captures the same compositor-containing scene as window and browser output.
The compositor does not add CPU pixel readback. Electron's shared-texture mode
is described in the [official offscreen rendering documentation](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/).

## Synchronization

Healthy POVs on the same map use the slowest eligible player as a stable anchor.
Default detection tolerance is 200 ms, observed every two seconds. Overrides are
`viewerSettings.syncThresholdMs` and `viewerSettings.syncIntervalMs`; detection
is bounded to at least 25 ms tolerance and a 100 ms interval. Sustained drift is
required before correction begins.

Routine correction changes playback speed by at most 5% around the original
song speed and updates at 10 Hz until clocks are within 10 ms. The song clock
remains continuous and forward-moving; the audio source is retained, including
when an audio offset is configured. Speed changes can temporarily affect audio
pitch if the audible POV requires correction. Score packets are selected against
each player's own rendered time. Startup, explicit seeks, replay pause events,
and initial synchronization of standalone TA viewers can still seek intentionally.

## Verification and remaining hardware check

Regression tests cover eight independent POVs sharing one renderer, resize-only
layout reads, hidden tiles, eight continuously advancing clocks, two-second
drift checks, audio-source retention with an audio offset, original song-speed
restoration, independent player colors/HSV, repeated cosmetic payloads, fog
clearing/caching, and bloom dimensions. These are logic and renderer-command
tests; they do not measure Windows GPU frame time.

Both production builds were checked. BeatKhana's full type check has existing
errors outside the modified replay files. ChroViewer's full test suite has an
existing BeatLeader ranking-order failure. Formatting/lint/type checking used
the repository rules through a temporary static Vite config, because the
installed check tooling cannot load the repository's callback config with its
extensionless imports. The production build uses the original build config.

Windows/OBS/Spout runtime validation remains necessary: compare 2, 6, and 8
players at the actual output resolution, with OBS hardware acceleration enabled,
and inspect frame times through multiple two-second sync checks, stream pauses,
late joins, and context recovery. A 60 FPS target is a budget, not a measured
hardware guarantee. Browser automation in this session was unavailable because
its tool failed during initialization.

## Recorded replays

A multiview player may set `replayUrl` (HTTPS) instead of following a live TA
stream. The tile then loads that recording, which can be any replay format the
viewer reads, including a recorded TA stream. It shows "Loading replay" until
the map and replay are ready, and stays visible while paused.

Recorded tiles never start on their own. The parent drives them together:

```ts
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'play' }, '*');
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'pause' }, '*');
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'seek', time: 42.5 }, '*');
```

Every command moves all recorded tiles to one shared time, so play and pause
also clear accumulated drift. While playing, the usual drift correction keeps
them aligned. Audio follows the normal rule: only the player with the highest
`masterVolume` is audible, so set the other players to `0`.

To show tiles at different times (e.g. two POVs out of sync as they were on
stream), seek one tile by its id:

```ts
iframe.contentWindow.postMessage(
  { type: 'beatkhana:multiview-control', version: 1, action: 'seek', time: 41.5, tileId: 'p2' },
  '*',
);
```

That tile then keeps its own time: drift correction leaves it alone, and play
and pause do not move it. A `seek` without `tileId` moves every recorded tile
to one time again and ends this.

To play the recorded tiles faster or slower (e.g. following a debug playback at
4x), set their speed; 1 is normal, from 0.01 to 16:

```ts
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'rate', rate: 4 }, '*');
```

A recorded tile can be sought before its first `play`: it stays paused at that
time and `play` starts it from there. Wait until the tile's `status` in
`beatkhana:multiview-state` is `watching` (its map, replay, song and difficulty
are loaded); a `seek` sent earlier is lost. Send `play` after a state message
shows the sought time, not in the same task as the `seek`.

## Song audio effects

On `/overlay` (multiview or a single viewer), the parent can fade the song down
and muffle it with a low-pass filter while it keeps playing, e.g. to keep a map
running quietly under other graphics. Hitsounds are not affected.

```ts
iframe.contentWindow.postMessage(
  { type: 'beatkhana:audio-fx', version: 1, volume: 0.3, lowpassHz: 800, rampMs: 1500 },
  '*',
);
// Back to normal
iframe.contentWindow.postMessage(
  { type: 'beatkhana:audio-fx', version: 1, volume: 1, lowpassHz: null, rampMs: 1000 },
  '*',
);
```

- `volume`: 0 to 1, a multiplier on the song after its normal volume; 1 is unchanged.
- `lowpassHz`: the cutoff in Hz, 20 or more (capped at the output's Nyquist
  frequency); `null` opens the filter fully.
- `rampMs`: 0 to 60000; both values ramp from where they are now (also mid-ramp), 0 is instant.

The effect applies to every tile and stays through seeks, play, pause and new
`beatkhana:multiview-config` messages (tiles loaded later start with it), until
the next `beatkhana:audio-fx` or a reload. Invalid messages are ignored.

## Parent-driven AI preview

The single `/overlay` (not multiview) plays a map with the built-in AI through
`map=<key>&aiDiff=<difficulty>&aiChar=<characteristic>`. It normally starts by
itself once a few seconds are generated. Add `parentControl=true` and it never
starts on its own: the AI still generates the play from the song start, and the
parent drives playback with the multiview control messages:

```ts
// /overlay?map=key&aiDiff=ExpertPlus&aiChar=Standard&parentControl=true
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'seek', time: 55 }, '*');
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'play' }, '*');
iframe.contentWindow.postMessage({ type: 'beatkhana:multiview-control', version: 1, action: 'pause' }, '*');
```

- `seek`: moves the playhead to `time` and keeps it paused (or playing). A time
  the AI has not generated yet (or a seek sent before `ready`) is kept and
  applied as soon as the play is generated that far and shown; playback holds
  still until then. Only the last seek counts.
- `play`: arms playback. It starts from the current (or pending sought) time
  once at least 3 seconds past the playhead are generated, by itself if that
  takes a while. Playing never runs past the generated play: it pauses at the
  edge and resumes once 3 seconds are ahead again.
- `pause`: pauses and disarms.
- `rate`, `sync` and a seek's `tileId` are ignored. Only messages from the
  parent frame count.

Commands take effect on the next 100 ms check. Five times a second the overlay
posts its state to the parent (to any origin until the parent has sent a
control message, then to that origin):

```ts
{
  type: 'beatkhana:preview-state',
  version: 1,
  ready: boolean, // the map, song and AI play are loaded and shown
  time: number, // the playhead, in seconds
  playing: boolean,
  generatedUntil: number, // song time the AI has generated up to; the duration once done
  duration: number, // 0 before the song is loaded
}
```

`beatkhana:audio-fx` works the same way in this mode. Without
`parentControl=true` nothing changes: the AI starts and plays by itself, and no
state is posted.

## Controlled live tiles

A play still in progress has no recording yet. To watch it from any point, set
`controlled: true` on a live player (no `replayUrl`) and give it a `catchupUrl`
setting: a TournamentAssistant replay file of the play so far.

```ts
{ id: 'p1', playerId: '76561198000000000', controlled: true, settings: { catchupUrl: 'https://...' }, ... }
```

The tile loads the catch-up, then keeps adding the live stream's packets to it.
It keeps the whole play in memory (no history is pruned behind the playhead),
so it can be sought anywhere from the play's start to the newest frame
(`seekableRange` in the tile's playback). It is shown, paused at the first
frame, once its map and first frames are in, and from then on it behaves like
a recorded tile: `play`, `pause`, `seek` and `rate` act on it, it never starts
or resumes on its own, `sync` leaves it alone, and the player's in-game pauses
are not applied (the parent pauses it). A new `catchupUrl` remounts the tile,
so it loads that play's history; a new play on the same live stream replaces
the old one in place.
