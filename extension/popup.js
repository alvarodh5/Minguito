// Minguito - popup (configuration UI)
// Reads/writes chrome.storage.local. The offscreen brain reacts to changes.

const $ = (id) => document.getElementById(id);

const KEYS = [
  "mode", "volume", "boost",
  "timeEnabled", "timeIntervalSec", "timeProbability",
  "keysEnabled", "trackEnter", "trackBackspace", "keyThreshold", "keyProbability",
  "selectedSounds", "serverUrl", "clientName", "c2cStatus",
  "cooldownSec", "quietEnabled", "quietStart", "quietEnd",
];

let state = {};

init();

async function init() {
  state = await chrome.storage.local.get(KEYS);
  await renderSounds();
  bind();
  render();

  // Live status updates while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [k, { newValue }] of Object.entries(changes)) state[k] = newValue;
    render();
  });
}

let SOUNDS = [];

async function renderSounds() {
  const res = await fetch(chrome.runtime.getURL("sounds.json"));
  const sounds = await res.json();
  SOUNDS = sounds;
  const wrap = $("sounds");
  wrap.innerHTML = "";
  const selected = new Set(state.selectedSounds || []);
  for (const s of sounds) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s.file;
    cb.checked = selected.has(s.file);
    cb.addEventListener("change", onSoundsChange);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(s.label));
    wrap.appendChild(label);
  }
}

function onSoundsChange() {
  const selected = [...document.querySelectorAll("#sounds input:checked")].map((c) => c.value);
  save({ selectedSounds: selected });
}

function bind() {
  // Mode buttons
  document.querySelectorAll("#modes button").forEach((btn) => {
    btn.addEventListener("click", () => save({ mode: btn.dataset.mode }));
  });

  $("timeEnabled").addEventListener("change", (e) => save({ timeEnabled: e.target.checked }));
  $("timeIntervalSec").addEventListener("change", (e) => save({ timeIntervalSec: clampInt(e.target.value, 1) }));
  $("timeProbability").addEventListener("input", (e) => save({ timeProbability: e.target.value / 100 }));

  $("keysEnabled").addEventListener("change", (e) => save({ keysEnabled: e.target.checked }));
  $("trackEnter").addEventListener("change", (e) => save({ trackEnter: e.target.checked }));
  $("trackBackspace").addEventListener("change", (e) => save({ trackBackspace: e.target.checked }));
  $("keyThreshold").addEventListener("change", (e) => save({ keyThreshold: clampInt(e.target.value, 1) }));
  $("keyProbability").addEventListener("input", (e) => save({ keyProbability: e.target.value / 100 }));

  $("serverUrl").addEventListener("change", (e) => save({ serverUrl: e.target.value.trim() }));
  $("clientName").addEventListener("change", (e) => save({ clientName: e.target.value.trim() }));
  $("volume").addEventListener("input", (e) => save({ volume: e.target.value / 100 }));
  $("boost").addEventListener("input", (e) => save({ boost: e.target.value / 100 }));

  $("cooldownSec").addEventListener("change", (e) => save({ cooldownSec: clampInt(e.target.value, 0) }));
  $("quietEnabled").addEventListener("change", (e) => save({ quietEnabled: e.target.checked }));
  $("quietStart").addEventListener("change", (e) => save({ quietStart: e.target.value }));
  $("quietEnd").addEventListener("change", (e) => save({ quietEnd: e.target.value }));

  $("testBtn").addEventListener("click", onTest);
}

function pickSoundFile() {
  const sel = state.selectedSounds || [];
  const pool = sel.length ? SOUNDS.filter((s) => sel.includes(s.file)) : SOUNDS;
  const list = pool.length ? pool : SOUNDS;
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)].file;
}

// Test flow: ask the offscreen brain to play (the real path). If that fails,
// fall back to playing in the popup itself (guaranteed user gesture) so you
// at least confirm the audio files and volume are fine.
async function onTest() {
  setMsg("testing…");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "minguito-test" });
  } catch (e) {
    res = { ok: false, error: String(e && e.message ? e.message : e) };
  }

  if (res && res.ok) {
    setMsg(`played via offscreen ✓ (${res.file || "ok"})`);
    return;
  }

  // Fallback: play directly in the popup.
  const file = pickSoundFile();
  if (!file) {
    setMsg("no sounds found — check sounds.json");
    return;
  }
  try {
    const audio = new Audio(chrome.runtime.getURL("sounds/" + file));
    audio.volume = clamp01(state.volume ?? 1);
    await audio.play();
    setMsg(`offscreen failed (${(res && res.error) || "?"}) — played in popup ✓`);
  } catch (e2) {
    setMsg(`playback failed: ${String(e2 && e2.message ? e2.message : e2)}`);
  }
}

function clamp01(n) {
  n = Number(n);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function setMsg(t) {
  $("testMsg").textContent = t;
}

function clampInt(v, min) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? min : Math.max(min, n);
}

async function save(patch) {
  Object.assign(state, patch);
  await chrome.storage.local.set(patch);
  render();
}

function render() {
  // Mode buttons + dot color
  document.querySelectorAll("#modes button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
  const dotColor = { ON: "#22c55e", OFF: "#ef4444", C2C: "#7c3aed" }[state.mode] || "#7c3aed";
  $("modeDot").style.background = dotColor;

  // Show/hide groups by mode
  $("localGroup").classList.toggle("disabled", state.mode !== "ON");
  $("c2cGroup").classList.toggle("disabled", state.mode !== "C2C");

  // Time
  $("timeEnabled").checked = !!state.timeEnabled;
  $("timeIntervalSec").value = state.timeIntervalSec ?? 60;
  $("timeProbability").value = Math.round((state.timeProbability ?? 0.5) * 100);
  $("timeProbVal").textContent = Math.round((state.timeProbability ?? 0.5) * 100) + "%";

  // Keys
  $("keysEnabled").checked = !!state.keysEnabled;
  $("trackEnter").checked = !!state.trackEnter;
  $("trackBackspace").checked = !!state.trackBackspace;
  $("keyThreshold").value = state.keyThreshold ?? 30;
  $("keyProbability").value = Math.round((state.keyProbability ?? 0.5) * 100);
  $("keyProbVal").textContent = Math.round((state.keyProbability ?? 0.5) * 100) + "%";

  // C2C
  $("serverUrl").value = state.serverUrl ?? "";
  $("clientName").value = state.clientName ?? "";
  const st = state.c2cStatus || "disconnected";
  const statusEl = $("c2cStatus");
  statusEl.textContent = st;
  statusEl.className = "status " + st;

  // Volume + boost
  $("volume").value = Math.round((state.volume ?? 1) * 100);
  $("volVal").textContent = Math.round((state.volume ?? 1) * 100) + "%";
  $("boost").value = Math.round((state.boost ?? 1) * 100);
  $("boostVal").textContent = Math.round((state.boost ?? 1) * 100) + "%";

  // Anti-spam
  $("cooldownSec").value = state.cooldownSec ?? 0;
  $("quietEnabled").checked = !!state.quietEnabled;
  $("quietStart").value = state.quietStart ?? "23:00";
  $("quietEnd").value = state.quietEnd ?? "08:00";
}
