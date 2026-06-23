// Minguito - content script
// Captures relevant keystrokes (Enter / Backspace) and forwards them to the
// brain (service worker + offscreen document). It makes no decisions: it only
// reports.

const TRACKED = new Set(["Enter", "Backspace"]);

document.addEventListener(
  "keydown",
  (e) => {
    if (!TRACKED.has(e.key)) return;
    try {
      chrome.runtime.sendMessage({ type: "minguito-key", key: e.key }).catch(() => {});
    } catch (_) {
      // The extension context may not be ready yet; ignore.
    }
  },
  true
);
