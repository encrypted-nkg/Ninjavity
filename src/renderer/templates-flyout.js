/* global api */

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

function clearFlyoutSizingClass() {
  document.documentElement.classList.remove("flyout-sized");
}

function reportFlyoutHeight() {
  clearFlyoutSizingClass();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const root = document.getElementById("flyoutRoot");
      if (!root) return;
      const h = Math.ceil(root.scrollHeight);
      const capped = Math.min(Math.max(h, 96), 560);
      try {
        api.reportClipboardFlyoutHeight(capped);
      } catch (_) {
        // ignore
      }
    });
  });
}

function render(payload) {
  const root = document.getElementById("templatesFlyoutItems");
  if (!root) return;
  root.innerHTML = "";
  const entries = payload?.entries || [];
  const selectedItemIndex = typeof payload?.selectedItemIndex === "number" ? payload.selectedItemIndex : -1;

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "clip-flyout-empty";
    empty.textContent = "No templates in this group yet.";
    root.appendChild(empty);
    reportFlyoutHeight();
    return;
  }

  entries.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "clip-flyout-item";
    div.setAttribute("role", "listitem");
    if (i === selectedItemIndex) div.classList.add("selected");
    const meta =
      entry.meta != null && entry.meta !== ""
        ? escapeHtml(String(entry.meta))
        : escapeHtml(formatTime(entry.copiedAt));
    div.innerHTML = `<div class="clip-flyout-text">${escapeHtml(entry.text)}</div><div class="meta">${meta}</div>`;
    div.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.paste(entry.text);
    });
    root.appendChild(div);
  });

  requestAnimationFrame(() => {
    const sel = root.querySelector(".clip-flyout-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  reportFlyoutHeight();
}

api.onTemplatesFlyoutRender((payload) => {
  render(payload);
});

if (api.onClipboardFlyoutSized) {
  api.onClipboardFlyoutSized(() => {
    document.documentElement.classList.add("flyout-sized");
  });
}

api.onThemeChange(({ effective }) => {
  if (effective === "light" || effective === "dark") {
    document.documentElement.dataset.theme = effective;
  }
});

const flyoutRoot = document.getElementById("flyoutRoot");
if (flyoutRoot) {
  flyoutRoot.addEventListener("mouseenter", () => {
    api.templatesFlyoutPeerHoverSend(true);
  });
  flyoutRoot.addEventListener("mouseleave", () => {
    api.templatesFlyoutPeerHoverSend(false);
  });
}
