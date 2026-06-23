// Minguito - offscreen document (the brain)
// IMPORTANT: offscreen documents can ONLY use chrome.runtime (messaging).
// chrome.storage, chrome.alarms, etc. are NOT available here. So this document
// never touches storage: the service worker pushes the config in, and we report
// status/results back out, all over chrome.runtime messaging.

let cfg = {};
let SOUNDS = []; // [{ file, label }]
let keyCount = 0;
let timeTimer = null;
let ws = null;
let reconnectTimer = null;
let ready; // promise resolved once sounds + initial config are loaded

// ---------------------------------------------------------------------------
// Message listener — registered FIRST and synchronously, with nothing above it
// that could throw, so it always exists for the service worker to reach.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "minguito-config":
      cfg = msg.cfg || {};
      applyConfig();
      return false;

    case "minguito-key":
      if (ready) ready.then(() => onKey(msg.key));
      return false;

    case "minguito-do-test":
      (ready || Promise.resolve())
        .then(() => playWithResult({ sound: randomSound() }, 1.0))
        .then(sendResponse);
      return true; // async response

    case "minguito-ping":
      sendResponse({ pong: true, connected: !!(ws && ws.readyState === WebSocket.OPEN) });
      return false;

    case "minguito-ensure-c2c":
      // Nudge from the service worker: reconnect if we should be connected
      // but aren't (and aren't already mid-connect).
      if (cfg.mode === "C2C" && (!ws || ws.readyState === WebSocket.CLOSED)) startC2C();
      return false;

    default:
      return false;
  }
});

// Reconnect immediately when the network comes back (e.g. after laptop sleep).
self.addEventListener("online", () => {
  if (cfg.mode === "C2C") startC2C();
});

// Kick off async init after the listener is in place.
ready = init();

async function init() {
  SOUNDS = await loadSounds();
  try {
    const res = await chrome.runtime.sendMessage({ type: "minguito-offscreen-ready" });
    if (res && res.cfg) cfg = res.cfg;
  } catch (_) {
    // Service worker may be waking up; a minguito-config push will follow.
  }
  applyConfig();
}

async function loadSounds() {
  try {
    const res = await fetch(chrome.runtime.getURL("sounds.json"));
    return await res.json();
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Config -> active behavior
// ---------------------------------------------------------------------------
function applyConfig() {
  startTimeTrigger();
  startC2C();
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function availableSounds() {
  const sel = Array.isArray(cfg.selectedSounds) ? cfg.selectedSounds : [];
  const pool = sel.length ? SOUNDS.filter((s) => sel.includes(s.file)) : SOUNDS;
  return pool.length ? pool : SOUNDS;
}

function randomSound() {
  const pool = availableSounds();
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)].file;
}

let lastPlayTs = 0;
let audioCtx = null;
const bufferCache = new Map(); // url -> decoded AudioBuffer

// Fire-and-forget playback used by the triggers. Respects the anti-spam gate.
// `desc` is { sound } (packaged file) or { url } (remote, e.g. uploaded).
function play(desc, volume) {
  if (!passesGate()) return;
  lastPlayTs = Date.now();
  playWithResult(desc, volume);
}

// True unless a cooldown or quiet-hours rule blocks playback right now.
function passesGate() {
  const cd = Number(cfg.cooldownSec) || 0;
  if (cd > 0 && Date.now() - lastPlayTs < cd * 1000) return false;
  if (cfg.quietEnabled && inQuietHours(cfg.quietStart, cfg.quietEnd)) return false;
  return true;
}

function inQuietHours(start, end) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start), e = toMinutes(end);
  if (s == null || e == null) return false;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e; // handles overnight
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function resolveUrl(desc) {
  if (!desc) return null;
  if (desc.url) return desc.url;
  if (desc.sound) return chrome.runtime.getURL("sounds/" + desc.sound);
  return null;
}

// Playback that resolves to { ok, error }. Reports the result to the service
// worker (which stores it for the popup). Never rejects. Bypasses the gate
// (used directly by the Test button and internally by play()).
async function playWithResult(desc, volume) {
  const url = resolveUrl(desc);
  const label = (desc && (desc.url || desc.sound)) || "?";
  if (!url) {
    return record({ ok: false, error: "no sound available (check sounds.json / selection)" });
  }
  const base = clamp01(volume != null ? volume : cfg.volume != null ? cfg.volume : 1);
  const gain = base * (Number(cfg.boost) || 1);
  try {
    if (gain <= 1) {
      // Known-good simple path (also works cross-origin for media playback).
      const audio = new Audio(url);
      audio.volume = clamp01(gain);
      await audio.play();
    } else {
      // Boost beyond 100% needs WebAudio (gain node can exceed 1).
      await playBoosted(url, gain);
    }
    return record({ ok: true, file: label });
  } catch (e) {
    return record({ ok: false, error: String(e && e.message ? e.message : e), file: label });
  }
}

async function playBoosted(url, gain) {
  if (!audioCtx) audioCtx = new (self.AudioContext || self.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  let buf = bufferCache.get(url);
  if (!buf) {
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    buf = await audioCtx.decodeAudioData(arr);
    bufferCache.set(url, buf);
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(audioCtx.destination);
  src.start();
}

function record(result) {
  const info = result.ok ? `played "${result.file}" ✓` : `error: ${result.error}`;
  try {
    chrome.runtime.sendMessage({ type: "minguito-set-playinfo", info });
  } catch (_) {}
  return result;
}

function clamp01(n) {
  n = Number(n);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Time-based trigger
// ---------------------------------------------------------------------------
function startTimeTrigger() {
  stopTimeTrigger();
  const active = cfg.mode === "ON" && cfg.timeEnabled && Number(cfg.timeIntervalSec) > 0;
  if (!active) return;
  timeTimer = setInterval(() => {
    if (Math.random() < Number(cfg.timeProbability)) play({ sound: randomSound() });
  }, Number(cfg.timeIntervalSec) * 1000);
}

function stopTimeTrigger() {
  if (timeTimer) {
    clearInterval(timeTimer);
    timeTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Keystroke-based trigger
// ---------------------------------------------------------------------------
function onKey(key) {
  if (cfg.mode !== "ON" || !cfg.keysEnabled) return;
  if (key === "Enter" && !cfg.trackEnter) return;
  if (key === "Backspace" && !cfg.trackBackspace) return;

  keyCount++;
  if (keyCount >= Number(cfg.keyThreshold)) {
    keyCount = 0;
    if (Math.random() < Number(cfg.keyProbability)) play({ sound: randomSound() });
  }
}

// ---------------------------------------------------------------------------
// C2C mode (remote control via WebSocket)
// ---------------------------------------------------------------------------
const HEARTBEAT_MS = 25000; // how often we ping the server
const PONG_TIMEOUT_MS = 10000; // how long we wait for any reply before giving up
let hbTimer = null;
let hbWatchdog = null;
let reconnectAttempts = 0;

function startC2C() {
  stopC2C();

  if (cfg.mode !== "C2C" || !cfg.serverUrl) {
    setStatus("disconnected");
    return;
  }

  setStatus("connecting");
  try {
    ws = new WebSocket(cfg.serverUrl);
  } catch (e) {
    setStatus("error");
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus("connected");
    safeSend({
      type: "hello",
      name: cfg.clientName || "",
      sounds: SOUNDS.map((s) => s.file),
    });
    startHeartbeat();
  };

  ws.onmessage = (ev) => {
    // Any message proves the link is alive -> cancel the pong watchdog.
    clearWatchdog();
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (data && data.type === "pong") return; // heartbeat reply, nothing to do
    if (data && data.action === "play") {
      const desc = data.url ? { url: data.url } : { sound: data.sound || randomSound() };
      play(desc, data.volume);
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    setStatus("disconnected");
    scheduleReconnect();
  };

  ws.onerror = () => setStatus("error");
}

function stopC2C() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch (_) {}
    ws = null;
  }
}

// App-level heartbeat: browsers can't send WS ping frames, so we send a JSON
// ping and expect a reply. If nothing comes back in time, the socket is a
// zombie (half-open) -> force-close it, which triggers onclose -> reconnect.
function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    safeSend({ type: "ping" });
    clearWatchdog();
    hbWatchdog = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch (_) {}
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
  clearWatchdog();
}

function clearWatchdog() {
  if (hbWatchdog) {
    clearTimeout(hbWatchdog);
    hbWatchdog = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || cfg.mode !== "C2C") return;
  reconnectAttempts++;
  // Quick first retry, then back off, capped at 15s.
  const delay = Math.min(15000, 1000 * reconnectAttempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (cfg.mode === "C2C") startC2C();
  }, delay);
}

function safeSend(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function setStatus(status) {
  try {
    chrome.runtime.sendMessage({ type: "minguito-set-status", status });
  } catch (_) {}
}
