// Minguito - service worker (MV3)
// A service worker cannot play audio, so it delegates ALL the work (timers,
// keystroke counting, C2C WebSocket and playback) to a persistent offscreen
// document. Here we only: set config defaults + keep the offscreen alive + a
// no-op listener so there is always a receiver for messages.

const OFFSCREEN_URL = "offscreen.html";

const DEFAULTS = {
  mode: "OFF", // OFF | ON | C2C
  volume: 1.0,

  // Time-based trigger
  timeEnabled: true,
  timeIntervalSec: 60,
  timeProbability: 0.5,

  // Keystroke-based trigger
  keysEnabled: true,
  trackEnter: true,
  trackBackspace: true,
  keyThreshold: 30,
  keyProbability: 0.5,

  // Selectable sounds (empty = all)
  selectedSounds: [],

  // Volume boost (1 = 100%, up to 5 = 500% via WebAudio gain)
  boost: 5.0,

  // Anti-spam
  cooldownSec: 0, // minimum seconds between sounds (0 = off)
  quietEnabled: false,
  quietStart: "23:00",
  quietEnd: "08:00",

  // C2C mode
  serverUrl: "ws://localhost:8787",
  clientName: "", // shown in the server panel for targeting (empty = auto)
  c2cStatus: "disconnected",
};

async function initDefaults() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (current[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

// Ensures the offscreen document exists. Returns:
//   { ok: true, existed: true|false }  on success
//   { ok: false, error: "<reason>" }   if creation genuinely failed
// The real createDocument error is captured (and stored) instead of swallowed.
async function ensureOffscreen() {
  try {
    if (!chrome.offscreen) {
      throw new Error("chrome.offscreen API not available (Chrome 109+ required)");
    }
    let has = false;
    try {
      has = await chrome.offscreen.hasDocument();
    } catch (_) {
      // hasDocument may be unavailable on some builds; fall through to create.
    }
    if (has) return { ok: true, existed: true };

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification:
        "Play Minguito sounds and keep timers and the C2C connection alive.",
    });
    chrome.storage.local.set({ offscreenError: "" });
    return { ok: true, existed: false };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // A concurrent create is fine: the document is there.
    if (/single offscreen|already exists|only.*one/i.test(msg)) {
      return { ok: true, existed: true };
    }
    chrome.storage.local.set({ offscreenError: msg });
    console.error("[Minguito] offscreen creation failed:", msg);
    return { ok: false, error: msg };
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Try to reach the offscreen document and run a test, retrying a few times.
// Returns the response, or null if it never answered.
async function tryTest() {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "minguito-do-test" });
      if (res) return res;
    } catch (_) {
      // "Receiving end does not exist" -> no listener yet; retry.
    }
    await wait(300);
  }
  return null;
}

// Ask the offscreen document to play a test sound. Ensures it exists, and if it
// exists but doesn't answer (a dead/ghost document), closes and recreates it.
async function runTest() {
  let ens = await ensureOffscreen();
  if (!ens.ok) return { ok: false, error: "offscreen create failed: " + ens.error };
  if (!ens.existed) await wait(400);

  let res = await tryTest();
  if (res) return res;

  // The document is unreachable. Tear it down and recreate it once.
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {}
  ens = await ensureOffscreen();
  if (!ens.ok) return { ok: false, error: "offscreen recreate failed: " + ens.error };
  await wait(500);

  res = await tryTest();
  return res || { ok: false, error: "offscreen created but not responding" };
}

chrome.runtime.onInstalled.addListener(async () => {
  await initDefaults();
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await initDefaults();
  await ensureOffscreen();
});

// Verify the offscreen document is alive AND responsive; recreate if it's a
// dead/ghost document. Also nudges the C2C connection back up if it dropped.
// This keeps the local/C2C triggers working without reopening the popup.
async function healthCheck() {
  const ens = await ensureOffscreen();
  if (!ens.ok) return;
  if (!ens.existed) {
    pushConfig(); // freshly created: make sure it has the config
    return;
  }
  let pong = null;
  try {
    pong = await chrome.runtime.sendMessage({ type: "minguito-ping" });
  } catch (_) {}
  if (!pong || !pong.pong) {
    // Dead/ghost document: recreate it.
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {}
    const again = await ensureOffscreen();
    if (again.ok) pushConfig();
    return;
  }
  // Alive: if it should be connected to C2C but isn't, nudge a reconnect.
  if (!pong.connected) {
    try {
      await chrome.runtime.sendMessage({ type: "minguito-ensure-c2c" });
    } catch (_) {}
  }
}

// Keep the offscreen document alive / recreate it periodically (30s is the
// minimum alarm period).
chrome.alarms.create("minguito-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "minguito-keepalive") healthCheck();
});

// The service worker owns chrome.storage; the offscreen document cannot access
// it. We read the config here and push it to the offscreen, and we accept
// status/result reports from the offscreen to persist for the popup.
async function getConfig() {
  return await chrome.storage.local.get(null);
}

async function pushConfig() {
  try {
    const cfg = await getConfig();
    await chrome.runtime.sendMessage({ type: "minguito-config", cfg });
  } catch (_) {
    // No offscreen listening yet; it will pull the config on load.
  }
}

// Keys written by us on behalf of the offscreen — changing them must NOT
// trigger a config re-push (would be a pointless loop).
const STATUS_KEYS = new Set(["c2cStatus", "lastPlayInfo", "offscreenError"]);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const relevant = Object.keys(changes).some((k) => !STATUS_KEYS.has(k));
  if (relevant) pushConfig();
});

// Message router.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "minguito-test":
      runTest().then(sendResponse);
      return true; // async

    case "minguito-offscreen-ready":
      // Offscreen just loaded and is asking for the current config.
      getConfig().then((cfg) => sendResponse({ cfg }));
      return true; // async

    case "minguito-set-status":
      chrome.storage.local.set({ c2cStatus: msg.status });
      return false;

    case "minguito-set-playinfo":
      chrome.storage.local.set({ lastPlayInfo: msg.info });
      return false;

    default:
      return false;
  }
});

// Immediate start when the SW spins up.
initDefaults().then(ensureOffscreen);
