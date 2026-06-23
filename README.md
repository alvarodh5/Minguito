# Minguito

A browser extension (Manifest V3) that plays sounds at full volume based on:

- **elapsed time** (every X seconds, with a configurable probability), and/or
- **keystrokes** (every N `Enter`/`Backspace` presses, with a probability),

…or remotely controlled by a **C2C server** that decides what to play and when.

## Modes

| Mode  | Behavior                                                                 |
|-------|--------------------------------------------------------------------------|
| `OFF` | Nothing plays.                                                           |
| `ON`  | Local triggers run (time + keystrokes), based on your thresholds.        |
| `C2C` | Connects to a server over WebSocket; the server commands the playback.   |

## Project layout

```
sound-trigger/
├── extension/          # the Manifest V3 extension
│   ├── manifest.json
│   ├── background.js   # service worker (keeps the offscreen doc alive)
│   ├── offscreen.html/js  # the "brain": timers, key counting, C2C, playback
│   ├── content.js      # captures Enter/Backspace and reports them
│   ├── popup.html/js   # configuration UI
│   ├── sounds.json     # list of available sounds
│   └── sounds/         # the .wav files (drop your own mp3/wav here)
└── server/             # the C2C server (Node.js)
    ├── server.js
    ├── package.json
    └── public/index.html  # web control panel
```

## Install the extension

1. Open `chrome://extensions` (Chrome/Edge/Brave).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `sound-trigger/extension` folder.
4. Click the Minguito icon to open the popup and pick a mode.

> Audio plays from a persistent **offscreen document**, so sounds fire even
> without a click on the page — including in `C2C` mode.

## Adding your own sounds

1. Drop `.mp3` / `.wav` files into `extension/sounds/`.
2. Add an entry to `extension/sounds.json`:
   ```json
   { "file": "my-sound.mp3", "label": "My sound" }
   ```
3. Reload the extension. The new sound shows up in the popup and the C2C panel.

The bundled sounds (`gallo`, `phone`, `scream`, `scream2/3/6/7`,
`what_are_u_doing`) are mp3 files.

## Running the C2C server

```bash
cd sound-trigger/server
npm install
npm start
```

Then:

- **Control panel:** http://localhost:8787
- **WebSocket (for the extension):** `ws://localhost:8787`

In the extension popup, switch to **C2C** and set the server URL to
`ws://localhost:8787`. The status turns `connected`.

### What the panel does

- **Connected browsers**: lists each browser by name (set the name in the popup
  under C2C; otherwise it shows `browser #N`).
- **Target**: send to *All browsers* or to one specific browser.
- **Play now**: send a specific sound (or a random one) to the target.
- **Add a sound**: drag-and-drop an mp3/wav to upload it to the server. Uploaded
  sounds are hosted by the server and played by the extension over its URL — so
  you can push sounds the extension doesn't have packaged.
- **Auto fire**: the server fires sounds on its own every X seconds with a
  given probability — this is the "server decides when" part.

### HTTP API (for scripts / curl)

```bash
# Play a packaged sound on all connected browsers
curl -X POST http://localhost:8787/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sound":"scream.mp3","volume":1}'

# Play on a single browser (id from /api/state)
curl -X POST http://localhost:8787/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sound":"scream.mp3","target":1}'

# Play an uploaded/remote sound by URL
curl -X POST http://localhost:8787/api/play \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:8787/sounds/myclip.mp3"}'

# Play a random sound
curl -X POST http://localhost:8787/api/play -d '{}'

# Upload a sound (filename in ?name=, raw bytes in the body)
curl -X POST "http://localhost:8787/api/upload?name=myclip.mp3" \
  --data-binary @myclip.mp3

# Turn the auto-fire loop on
curl -X POST http://localhost:8787/api/auto \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"intervalSec":15,"probability":0.7}'

# Current state (connected clients with names, sound catalog, auto config)
curl http://localhost:8787/api/state
```

The server listens on `PORT` (default `8787`): `PORT=9000 npm start`. Uploaded
files are stored in `server/uploads/`.

## Other features

- **Volume boost**: the volume slider goes to 100%, and a separate **Boost**
  slider (up to 500%) drives a WebAudio gain stage to push past the normal max
  (it will distort — that's the point).
- **Anti-spam**: a **Cooldown** (minimum seconds between sounds) and **Quiet
  hours** (a no-sound time window, overnight ranges supported). These apply to
  the time, keystroke and C2C triggers — but not to the Test button.
- **Per-browser naming/targeting**: name each browser in the popup; the server
  panel can then fire at one browser instead of all of them.

## How triggering works

- **Time:** every `timeIntervalSec` seconds it rolls a die; if it lands under
  `timeProbability`, a random selected sound plays.
- **Keys:** each tracked `Enter`/`Backspace` increments a counter; when it
  reaches `keyThreshold`, it rolls against `keyProbability` and resets.
- **Sounds:** if you tick specific sounds in the popup, only those are eligible;
  if none are ticked, all sounds are eligible.
- **Volume:** `1.0` = max (the browser cannot exceed the OS volume).
