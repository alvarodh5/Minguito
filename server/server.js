// Minguito - C2C server
// Extensions connect over WebSocket. This server decides what sound to play and
// when, and sends "play" commands to connected browsers (all of them, or a
// specific one). It also:
//   - serves a web control panel (manual buttons + a server-driven auto loop),
//   - exposes a small HTTP API (curl-friendly),
//   - accepts sound uploads and serves them so the extension can fetch & play
//     them remotely (sounds it doesn't have packaged).

import http from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const UPLOADS_DIR = join(__dirname, "uploads");

const AUDIO_TYPES = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

// Connected extensions: id -> { id, name, sounds, socket }
const clients = new Map();
let nextClientId = 1;

// Last host header we saw, so the auto loop can build absolute upload URLs.
let publicHost = `localhost:${PORT}`;

// Server-side auto-fire loop ("the server decides when").
const auto = { enabled: false, intervalSec: 30, probability: 0.5, timer: null };

await mkdir(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// HTTP server (control panel + JSON API + uploaded-sound hosting)
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  publicHost = req.headers.host || publicHost;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return end(res, 204, "");

  // Control panel
  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await readFile(join(__dirname, "public", "index.html"));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return end(res, 200, html);
    } catch {
      return end(res, 500, "panel not found");
    }
  }

  // Serve an uploaded sound to the extension.
  if (req.method === "GET" && url.pathname.startsWith("/sounds/")) {
    const name = safeName(decodeURIComponent(url.pathname.slice("/sounds/".length)));
    if (!name) return end(res, 400, "bad name");
    try {
      const data = await readFile(join(UPLOADS_DIR, name));
      res.setHeader("Content-Type", AUDIO_TYPES[extname(name).toLowerCase()] || "application/octet-stream");
      return end(res, 200, data);
    } catch {
      return end(res, 404, "not found");
    }
  }

  // State for the panel.
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, {
      clients: [...clients.values()].map((c) => ({ id: c.id, name: clientLabel(c) })),
      sounds: await soundCatalog(req.headers.host),
      auto: pickAuto(),
    });
  }

  // Play a sound (optionally on a single target client).
  if (req.method === "POST" && url.pathname === "/api/play") {
    const body = await readJsonBody(req);
    const target = body.target && body.target !== "all" ? Number(body.target) : null;
    let { sound, url: soundUrl } = body;
    if (!sound && !soundUrl) {
      const pick = await randomPayload(req.headers.host);
      sound = pick.sound;
      soundUrl = pick.url;
    }
    const n = broadcastPlay({ sound, url: soundUrl, volume: body.volume, target });
    return json(res, 200, { ok: true, sentTo: n, sound, url: soundUrl, target: target ?? "all" });
  }

  // Configure / toggle the auto-fire loop.
  if (req.method === "POST" && url.pathname === "/api/auto") {
    const body = await readJsonBody(req);
    if (body.intervalSec != null) auto.intervalSec = Math.max(1, Number(body.intervalSec));
    if (body.probability != null) auto.probability = clamp01(body.probability);
    if (body.enabled != null) body.enabled ? startAuto() : stopAuto();
    return json(res, 200, { ok: true, auto: pickAuto() });
  }

  // Upload a sound. Filename in ?name=, raw bytes in the body.
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const name = safeName(url.searchParams.get("name") || "");
    if (!name || !(extname(name).toLowerCase() in AUDIO_TYPES)) {
      return json(res, 400, { ok: false, error: "invalid filename or type (mp3/wav/ogg/m4a/aac/flac)" });
    }
    const data = await readRawBody(req);
    if (!data.length) return json(res, 400, { ok: false, error: "empty body" });
    await writeFile(join(UPLOADS_DIR, name), data);
    console.log(`[upload] saved ${name} (${data.length} bytes)`);
    return json(res, 200, { ok: true, name, url: `http://${req.headers.host}/sounds/${encodeURIComponent(name)}` });
  }

  return end(res, 404, "not found");
});

// ---------------------------------------------------------------------------
// WebSocket server (the extensions)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  const id = nextClientId++;
  const client = { id, name: "", sounds: [], socket };
  clients.set(id, client);
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true; // reply to our native ping frame
  });
  console.log(`[+] client #${id} connected (${clients.size} total) from ${req.socket.remoteAddress}`);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (typeof msg.name === "string") client.name = msg.name.slice(0, 60);
      if (Array.isArray(msg.sounds)) client.sounds = msg.sounds;
      console.log(`    #${id} is "${clientLabel(client)}" with: ${client.sounds.join(", ")}`);
    } else if (msg.type === "ping") {
      // App-level heartbeat from the extension; reply so it knows we're alive.
      socket.isAlive = true;
      try {
        socket.send(JSON.stringify({ type: "pong" }));
      } catch {}
    }
  });

  socket.on("close", () => {
    clients.delete(id);
    console.log(`[-] client #${id} disconnected (${clients.size} total)`);
  });
  socket.on("error", () => {});
});

// Native ping/pong sweep: drop sockets that stopped responding (half-open
// connections from sleep/network drops) so the client list stays accurate.
const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const c of clients.values()) {
    const s = c.socket;
    if (s.isAlive === false) {
      console.log(`[hb] terminating unresponsive client #${c.id}`);
      try {
        s.terminate();
      } catch {}
      continue;
    }
    s.isAlive = false;
    try {
      s.ping();
    } catch {}
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// Playback / catalog helpers
// ---------------------------------------------------------------------------
function broadcastPlay({ sound, url, volume, target }) {
  const payload = JSON.stringify({ action: "play", sound, url, volume });
  let n = 0;
  for (const c of clients.values()) {
    if (target != null && c.id !== target) continue;
    if (c.socket.readyState === 1 /* OPEN */) {
      c.socket.send(payload);
      n++;
    }
  }
  const what = url || sound || "(random)";
  console.log(`>> play "${what}" -> ${n} client(s)${target != null ? ` [target #${target}]` : ""}`);
  return n;
}

function clientLabel(c) {
  return c.name || `browser #${c.id}`;
}

// Union of every connected client's packaged sounds + the uploaded files.
async function soundCatalog(host) {
  const packaged = new Set();
  for (const c of clients.values()) c.sounds.forEach((s) => packaged.add(s));
  const list = [...packaged].map((file) => ({ label: file, kind: "packaged", sound: file }));

  for (const file of await uploadedFiles()) {
    list.push({
      label: file,
      kind: "uploaded",
      url: `http://${host}/sounds/${encodeURIComponent(file)}`,
    });
  }
  return list;
}

async function uploadedFiles() {
  try {
    const entries = await readdir(UPLOADS_DIR);
    return entries.filter((f) => extname(f).toLowerCase() in AUDIO_TYPES);
  } catch {
    return [];
  }
}

async function randomPayload(host) {
  const catalog = await soundCatalog(host);
  if (!catalog.length) return {};
  const pick = catalog[Math.floor(Math.random() * catalog.length)];
  return pick.kind === "uploaded" ? { url: pick.url } : { sound: pick.sound };
}

function startAuto() {
  stopAuto();
  auto.enabled = true;
  auto.timer = setInterval(async () => {
    if (Math.random() < auto.probability) {
      const pick = await randomPayload(publicHost);
      broadcastPlay({ sound: pick.sound, url: pick.url, volume: 1, target: null });
    }
  }, auto.intervalSec * 1000);
  console.log(`[auto] ON every ${auto.intervalSec}s @ p=${auto.probability}`);
}

function stopAuto() {
  if (auto.timer) clearInterval(auto.timer);
  auto.timer = null;
  auto.enabled = false;
  console.log("[auto] OFF");
}

function pickAuto() {
  return { enabled: auto.enabled, intervalSec: auto.intervalSec, probability: auto.probability };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function safeName(name) {
  const base = basename(String(name)).trim();
  if (!base || base.startsWith(".")) return null;
  return /^[A-Za-z0-9._ -]+$/.test(base) ? base : null;
}

function clamp01(n) {
  n = Number(n);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, obj) {
  res.setHeader("Content-Type", "application/json");
  end(res, code, JSON.stringify(obj));
}

function end(res, code, body) {
  res.statusCode = code;
  res.end(body);
}

server.listen(PORT, () => {
  console.log(`Minguito C2C server listening on:`);
  console.log(`  WebSocket : ws://localhost:${PORT}`);
  console.log(`  Panel     : http://localhost:${PORT}`);
});
