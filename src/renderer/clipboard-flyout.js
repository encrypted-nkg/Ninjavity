/* global api, FlyoutList */

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(epochMs) {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// All content is local text with system fonts. Reading geometry flushes layout
// now; waiting for two animation frames adds latency to hidden/occluded windows.
function reportFlyoutHeight() {
  const root = document.getElementById("flyoutRoot");
  if (!root) return;
  const h = listView.naturalHeight(root);
  api.reportClipboardFlyoutHeight(Math.min(Math.max(h, 96), 560));
}

function buildCards(payload) {
  const root = document.getElementById("clipboardFlyoutItems");
  if (!root) return;
  const entries = payload?.entries || [];

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "clip-flyout-empty";
    empty.textContent = "No clips in this group yet.";
    root.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "clip-flyout-item";
    div.setAttribute("role", "listitem");
    div.innerHTML = `<div class="clip-flyout-text">${escapeHtml(entry.text)}</div><div class="meta">${formatTime(entry.copiedAt)}</div>`;
    div.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.paste(entry.text);
    });
    root.appendChild(div);
  });
}

const listView = new FlyoutList(
  document.getElementById("clipboardFlyoutItems"), buildCards, reportFlyoutHeight,
);
// Keep the viewport constrained throughout navigation and content measurement.
document.documentElement.classList.add("flyout-sized");
window.addEventListener("resize", () => listView.revealSelection());

api.onClipboardFlyoutRender((payload) => {
  listView.render(payload);
});

if (api.onClipboardFlyoutSized) {
  api.onClipboardFlyoutSized(() => {
    listView.revealSelection();
  });
}

api.onThemeChange(({ effective }) => {
  if (effective === "light" || effective === "dark") {
    document.documentElement.dataset.theme = effective;
  }
});

// Throttled heartbeat so the main process knows this window is in use.
let lastInteractionSentAt = 0;
for (const evt of ["mousemove", "mousedown", "wheel"]) {
  document.addEventListener(
    evt,
    () => {
      const now = Date.now();
      if (now - lastInteractionSentAt < 200) return;
      lastInteractionSentAt = now;
      try {
        api.reportInteraction?.();
      } catch (_) {
        // ignore
      }
    },
    { passive: true },
  );
}

const flyoutRoot = document.getElementById("flyoutRoot");
if (flyoutRoot) {
  flyoutRoot.addEventListener("mouseenter", () => {
    api.clipboardFlyoutPeerHoverSend(true);
  });
  flyoutRoot.addEventListener("mouseleave", () => {
    api.clipboardFlyoutPeerHoverSend(false);
  });
}
