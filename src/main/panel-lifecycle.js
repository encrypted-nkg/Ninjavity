// Keep only the latest payload per channel while a renderer starts. Hidden/destroyed
// windows must never replay a stale request when they eventually finish loading.
function createWindowDelivery() {
  const states = new WeakMap();
  return {
    attach(win) {
      const state = { ready: false, pending: new Map() };
      states.set(win, state);
      win.webContents.on("did-start-loading", () => { state.ready = false; });
      win.webContents.on("did-finish-load", () => {
        if (win.isDestroyed()) return;
        state.ready = true;
        for (const [channel, payload] of state.pending) win.webContents.send(channel, payload);
        state.pending.clear();
      });
      win.on("closed", () => states.delete(win));
    },
    send(win, channel, payload) {
      if (!win || win.isDestroyed()) return;
      const state = states.get(win);
      if (!state) return;
      if (state.ready) win.webContents.send(channel, payload);
      else state.pending.set(channel, payload);
    },
    cancel(win) { states.get(win)?.pending.clear(); },
  };
}

function clampToWorkArea(bounds, workArea) {
  const margin = 8;
  const width = Math.min(bounds.width, Math.max(1, workArea.width - margin * 2));
  const height = Math.min(bounds.height, Math.max(1, workArea.height - margin * 2));
  return {
    width,
    height,
    x: Math.round(Math.max(workArea.x + margin, Math.min(bounds.x, workArea.x + workArea.width - width - margin))),
    y: Math.round(Math.max(workArea.y + margin, Math.min(bounds.y, workArea.y + workArea.height - height - margin))),
  };
}

module.exports = { createWindowDelivery, clampToWorkArea };
