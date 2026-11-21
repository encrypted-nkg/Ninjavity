/* global api, FlyoutList, addSnippetEditButton, ListReorder */

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

const snippetReorder = new ListReorder(document.getElementById('templatesFlyoutItems'), '.clip-flyout-item',
  move => api.reorderTemplates({ kind: 'snippet', ...move }), active => {
    api.setAutoDismiss?.(!active);
    if (active) api.templatesFlyoutPeerHoverSend(true);
  });

function buildCards(payload) {
  const root = document.getElementById("templatesFlyoutItems");
  if (!root) return;
  const pasteOnClick = payload?.pasteOnClick === true;
  const entries = payload?.entries || [];

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "clip-flyout-empty";
    empty.textContent = "No templates in this group yet.";
    root.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "clip-flyout-item";
    div.setAttribute("role", "listitem");
    const meta =
      entry.meta != null && entry.meta !== ""
        ? escapeHtml(String(entry.meta))
        : escapeHtml(formatTime(entry.copiedAt));
    div.innerHTML = `<div class="clip-flyout-text">${escapeHtml(entry.text)}</div><div class="meta">${meta}</div>`;
    div.title = pasteOnClick ? "Click to paste · double-click to edit" : "Double-click to edit";
    let clickTimer = null;
    let suppressClickPaste = false;
    div.addEventListener('reorder-start', () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = null;
    });
    if (entry.id) addSnippetEditButton(div, entry.name || entry.meta, () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = null;
      api.openTemplatesEditor(entry.id);
    });
    div.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!pasteOnClick) return;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (!suppressClickPaste) api.paste(entry.text);
        suppressClickPaste = false;
      }, 250);
    });
    div.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      suppressClickPaste = true;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      if (entry.id) {
        try {
          api.openTemplatesEditor(entry.id);
        } catch (_) {
          // ignore
        }
      }
    });
    snippetReorder.addHandle(div, entry.id, entry.name || entry.meta || "snippet");
    root.appendChild(div);
  });
}

const listView = new FlyoutList(
  document.getElementById("templatesFlyoutItems"), buildCards, reportFlyoutHeight,
);
// Keep the viewport constrained throughout navigation and content measurement.
document.documentElement.classList.add("flyout-sized");
window.addEventListener("resize", () => listView.revealSelection());

api.onTemplatesFlyoutRender((payload) => {
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
    api.templatesFlyoutPeerHoverSend(true);
  });
  flyoutRoot.addEventListener("mouseleave", () => {
    if (!snippetReorder.dragging) api.templatesFlyoutPeerHoverSend(false);
  });
}
