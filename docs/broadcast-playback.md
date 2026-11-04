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
