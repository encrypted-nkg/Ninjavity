/* global api */
const rootEl = document.getElementById("root");
const modeTitle = document.getElementById("modeTitle");
const closeBtn = document.getElementById("closeBtn");
const clipboardFlyout = document.getElementById("clipboardFlyout");

const tabClipboard = document.getElementById("tabClipboard");
const tabTemplates = document.getElementById("tabTemplates");
const tabTodos = document.getElementById("tabTodos");
const tabSettings = document.getElementById("tabSettings");

const clipboardSection = document.getElementById("clipboardSection");
const templatesSection = document.getElementById("templatesSection");
const todosSection = document.getElementById("todosSection");

const clipboardList = document.getElementById("clipboardList");

const templatesListWrap = document.getElementById("templatesListWrap");
const templatesGroupList = document.getElementById("templatesGroupList");
const templatesFlyout = document.getElementById("templatesFlyout");

const listModeBtn = document.getElementById("listModeBtn");
const configModeBtn = document.getElementById("configModeBtn");
const templatesConfigWrap = document.getElementById("templatesConfigWrap");

const tmplGroup = document.getElementById("tmplGroup");
const tmplName = document.getElementById("tmplName");
const tmplText = document.getElementById("tmplText");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const saveStatus = document.getElementById("saveStatus");

const templatesConfigList = document.getElementById("templatesConfigList");
const settingsSection = document.getElementById("settingsSection");
const infoSection = document.getElementById("infoSection");
const infoScroll = document.getElementById("infoScroll");
const toggleStartupBtnSettings = document.getElementById("toggleStartupBtnSettings");
const setClipboardGroups = document.getElementById("setClipboardGroups");
const setClipboardPerGroup = document.getElementById("setClipboardPerGroup");
const setSavedGroupsMax = document.getElementById("setSavedGroupsMax");
const setSavedPerGroup = document.getElementById("setSavedPerGroup");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");
const themeSelect = document.getElementById("themeSelect");

const todoInput = document.getElementById("todoInput");
const todoDateInput = document.getElementById("todoDateInput");
const todoAddBtn = document.getElementById("todoAddBtn");
const todoList = document.getElementById("todoList");
const todoClearDoneBtn = document.getElementById("todoClearDoneBtn");
const todoQuickAddSection = document.getElementById("todoQuickAddSection");
const todoQuickInput = document.getElementById("todoQuickInput");
const todoQuickDate = document.getElementById("todoQuickDate");
const todosTodaySection = document.getElementById("todosTodaySection");
const todosTodayList = document.getElementById("todosTodayList");
const todosTodayDateLabel = document.getElementById("todosTodayDateLabel");
const todosTodayCountEl = document.getElementById("todosTodayCount");
const todosTodayQuickInput = document.getElementById("todosTodayQuickInput");
const todosTodayAddBtn = document.getElementById("todosTodayAddBtn");

/** @type {Array<{ id: string, text: string, done: boolean, createdAt: number, targetDate: string }>} */
let lastTodos = [];
/** Full list from the main process (before chip filter). */
let lastTodosFull = [];
/** @type {"all"|"today"|"tomorrow"|"week"|"month"} */
let todoFilter = "all";

const TODO_FILTER_IDS = new Set(["all", "today", "tomorrow", "week", "month"]);

/** @param {string} effective */
function applyTheme(effective) {
  const t = effective === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
}

/**
 * Match main process: dark / light / system → resolved light or dark for CSS.
 * @param {{ theme?: string }} settings
 */
function applyThemeFromSettings(settings) {
  const pref = settings?.theme || "system";
  let effective = "dark";
  if (pref === "dark") effective = "dark";
  else if (pref === "light") effective = "light";
  else {
    effective = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  applyTheme(effective);
}

let uiMode = "clipboard"; // 'clipboard' | 'templates' | 'todos' | 'settings' | 'info' | 'todoQuickAdd' | 'todosToday'
let templateView = "list"; // 'list' | 'configure'

let clipboardItems = [];
/** @type {{ name: string, entries: Array<{ text: string, copiedAt?: number }> }[]} */
let clipboardGroupRows = [];
let lastClipboardSettings = { clipboardGroups: 10, clipboardPerGroup: 10 };
let lastTemplatesGrouped = [];
let lastTemplatesAll = [];
/** @type {{ name: string, items: Array<{ id?: string, name?: string, text?: string, group?: string }> }[]} */
let templateGroupRows = [];

let selectedIndex = -1;
let editingTemplateId = null;

/** Cmd+Shift+V slim mode */
let clipboardCompact = false;
/** Cmd+Shift+B slim mode (SavedClip): group list + separate items window */
let templatesCompact = false;
/** Hover target row index, or null */
let clipboardHoverIndex = null;
/** After first ArrowUp/ArrowDown in clipboard, show flyout for selection */
let clipboardKeyboardNav = false;
let clipboardFlyoutMouseInside = false;
/** Separate flyout window (compact shortcut): pointer is over the items window */
let clipboardFlyoutPeerHover = false;
let clipboardFlyoutLeaveTimer = null;
/** 'groups' = Clip rows only; 'items' = texts inside flyout (after ArrowRight) */
let clipboardNavPane = "groups";
let clipboardItemIndex = 0;

/** Templates list: same two-pane model as clipboard */
let templateNavPane = "groups";
let templateItemIndex = 0;
let templateHoverIndex = null;
let templateKeyboardNav = false;
let templatesFlyoutMouseInside = false;
let templatesFlyoutPeerHover = false;
let templatesFlyoutLeaveTimer = null;

function hideClipboardFlyout() {
  if (clipboardCompact) {
    try {
      api.clipboardFlyoutHide();
    } catch (_) {
      // ignore
    }
  }
  if (!clipboardFlyout) return;
  clipboardFlyout.classList.add("hidden");
  clipboardFlyout.setAttribute("aria-hidden", "true");
  clipboardFlyout.innerHTML = "";
}

function fillClipboardFlyoutContent(group, selectedItemIndex = -1) {
  if (!clipboardFlyout) return;
  clipboardFlyout.innerHTML = "";
  if (!group?.entries?.length) {
    const empty = document.createElement("div");
    empty.className = "clip-flyout-empty";
    empty.textContent = "No clips in this group yet.";
    clipboardFlyout.appendChild(empty);
    return;
  }
  group.entries.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "clip-flyout-item";
    if (i === selectedItemIndex) div.classList.add("selected");
    div.innerHTML = `<div class="clip-flyout-text">${escapeHtml(entry.text)}</div><div class="meta">${formatTime(entry.copiedAt)}</div>`;
    div.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.paste(entry.text);
    });
    clipboardFlyout.appendChild(div);
  });
  requestAnimationFrame(() => {
    const sel = clipboardFlyout.querySelector(".clip-flyout-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function hideTemplatesFlyout() {
  if (templatesCompact) {
    try {
      api.templatesFlyoutHide();
    } catch (_) {
      // ignore
    }
  }
  if (!templatesFlyout) return;
  templatesFlyout.classList.add("hidden");
  templatesFlyout.setAttribute("aria-hidden", "true");
  templatesFlyout.innerHTML = "";
}

function fillTemplatesFlyoutContent(group, selectedItemIndex = -1) {
  if (!templatesFlyout) return;
  templatesFlyout.innerHTML = "";
  if (!group?.items?.length) {
    const empty = document.createElement("div");
    empty.className = "clip-flyout-empty";
    empty.textContent = "No templates in this group.";
    templatesFlyout.appendChild(empty);
    return;
  }
  group.items.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "clip-flyout-item";
    if (i === selectedItemIndex) div.classList.add("selected");
    const meta = [entry.name || "Untitled", entry.group || group.name].filter(Boolean).join(" · ");
    div.innerHTML = `<div class="clip-flyout-text">${escapeHtml(entry.text || "")}</div><div class="meta">${escapeHtml(meta)}</div>`;
    div.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.paste(entry.text || "");
    });
    templatesFlyout.appendChild(div);
  });
  requestAnimationFrame(() => {
    const sel = templatesFlyout.querySelector(".clip-flyout-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function syncTemplatesFlyout() {
  if (uiMode !== "templates" || templateView !== "list" || !templatesFlyout) {
    hideTemplatesFlyout();
    return;
  }
  const groupIdx =
    templateNavPane === "items"
      ? selectedIndex
      : templateHoverIndex !== null
        ? templateHoverIndex
        : selectedIndex;
  if (groupIdx < 0 || groupIdx >= templateGroupRows.length) {
    hideTemplatesFlyout();
    return;
  }
  const row = templatesGroupList.querySelector(`.clip-group-wrap[data-index="${groupIdx}"]`);
  if (!row) {
    hideTemplatesFlyout();
    return;
  }
  const group = templateGroupRows[groupIdx];
  const itemSel = templateNavPane === "items" ? templateItemIndex : -1;

  const showFlyout =
    templateNavPane === "items" || templateHoverIndex !== null || templateKeyboardNav;
  if (!showFlyout) {
    hideTemplatesFlyout();
    return;
  }

  if (templatesCompact) {
    try {
      api.templatesFlyoutSync({
        show: true,
        entries: (group.items || []).map((item) => ({
          text: item.text || "",
          meta: [item.name || "Untitled", item.group || group.name].filter(Boolean).join(" · "),
        })),
        selectedItemIndex: itemSel,
      });
    } catch (_) {
      // ignore
    }
    return;
  }

  fillTemplatesFlyoutContent(group, itemSel);
  templatesFlyout.classList.remove("hidden");
  templatesFlyout.setAttribute("aria-hidden", "false");
}

function setTemplateGroupIndex(nextIdx) {
  selectedIndex = nextIdx;
  const rows = templatesGroupList.querySelectorAll(".clip-group-wrap");
  rows.forEach((li, i) => {
    li.classList.toggle("selected", i === selectedIndex);
  });
  syncTemplatesFlyout();
}

function syncClipboardFlyout() {
  if (uiMode !== "clipboard" || !clipboardFlyout) {
    hideClipboardFlyout();
    return;
  }
  const groupIdx =
    clipboardNavPane === "items"
      ? selectedIndex
      : clipboardHoverIndex !== null
        ? clipboardHoverIndex
        : selectedIndex;
  if (groupIdx < 0 || groupIdx >= clipboardGroupRows.length) {
    hideClipboardFlyout();
    return;
  }
  const row = clipboardList.querySelector(`.clip-group-wrap[data-index="${groupIdx}"]`);
  if (!row) {
    hideClipboardFlyout();
    return;
  }
  const group = clipboardGroupRows[groupIdx];
  const itemSel = clipboardNavPane === "items" ? clipboardItemIndex : -1;

  const showFlyout =
    clipboardNavPane === "items" ||
    clipboardHoverIndex !== null ||
    clipboardKeyboardNav;
  if (!showFlyout) {
    hideClipboardFlyout();
    return;
  }

  if (clipboardCompact) {
    try {
      api.clipboardFlyoutSync({
        show: true,
        entries: group.entries,
        selectedItemIndex: itemSel,
      });
    } catch (_) {
      // ignore
    }
    return;
  }

  fillClipboardFlyoutContent(group, itemSel);
  clipboardFlyout.classList.remove("hidden");
  clipboardFlyout.setAttribute("aria-hidden", "false");
}

function setClipboardGroupIndex(nextIdx) {
  selectedIndex = nextIdx;
  const rows = clipboardList.querySelectorAll(".clip-group-wrap");
  rows.forEach((li, i) => {
    li.classList.toggle("selected", i === selectedIndex);
  });
  syncClipboardFlyout();
}

function clearStatus() {
  saveStatus.textContent = "";
}

function setStatus(msg) {
  saveStatus.textContent = msg;
}

function setSettingsStatus(msg) {
  if (!settingsStatus) return;
  settingsStatus.textContent = msg || "";
}

function clearClipboardCompactSizingClasses() {
  document.documentElement.classList.remove("clipboard-compact-main-sized");
  if (rootEl) rootEl.classList.remove("clipboard-compact-dual--locked");
}

function clearTemplatesCompactSizingClasses() {
  document.documentElement.classList.remove("templates-compact-main-sized");
  if (rootEl) rootEl.classList.remove("templates-compact-dual--locked");
}

function reportClipboardCompactMainHeightIfNeeded() {
  if (!clipboardCompact || uiMode !== "clipboard") return;
  clearClipboardCompactSizingClasses();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const root = document.getElementById("root");
      if (!root) return;
      const h = Math.ceil(root.scrollHeight);
      const capped = Math.min(Math.max(h, 96), 560);
      try {
        api.reportClipboardMainHeight(capped);
      } catch (_) {
        // ignore
      }
    });
  });
}

function reportTemplatesCompactMainHeightIfNeeded() {
  if (!templatesCompact || uiMode !== "templates") return;
  clearTemplatesCompactSizingClasses();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const root = document.getElementById("root");
      if (!root) return;
      const h = Math.ceil(root.scrollHeight);
      const capped = Math.min(Math.max(h, 96), 560);
      try {
        api.reportClipboardMainHeight(capped);
      } catch (_) {
        // ignore
      }
    });
  });
}

function renderClipboardList(items, settings) {
  clearTimeout(clipboardFlyoutLeaveTimer);
  clipboardFlyoutLeaveTimer = null;
  clipboardFlyoutPeerHover = false;
  hideClipboardFlyout();
  clipboardHoverIndex = null;
  clipboardKeyboardNav = false;
  clipboardFlyoutMouseInside = false;
  clipboardNavPane = "groups";
  clipboardItemIndex = 0;

  clipboardList.innerHTML = "";
  clipboardItems = items || [];
  const s = settings || lastClipboardSettings;
  lastClipboardSettings = {
    clipboardGroups: Number(s.clipboardGroups) || 10,
    clipboardPerGroup: Number(s.clipboardPerGroup) || 10,
  };

  const numGroups = Math.max(1, Math.min(20, lastClipboardSettings.clipboardGroups));
  const perGroup = Math.max(1, Math.min(20, lastClipboardSettings.clipboardPerGroup));

  clipboardGroupRows = [];
  for (let gi = 0; gi < numGroups; gi++) {
    const start = gi * perGroup;
    const chunk = clipboardItems.slice(start, start + perGroup);
    clipboardGroupRows.push({ name: `Clip${gi + 1}`, entries: chunk });
  }

  clipboardGroupRows.forEach((group, idx) => {
    const li = document.createElement("li");
    li.className = "clip-group-wrap";
    li.dataset.index = String(idx);
    li.setAttribute("role", "option");

    const row = document.createElement("div");
    row.className = "clip-group-row";
    row.innerHTML = `<span>${escapeHtml(group.name)}</span><span class="chevron">›</span>`;
    li.appendChild(row);

    li.addEventListener("mouseenter", () => {
      if (clipboardCompact) {
        clearTimeout(clipboardFlyoutLeaveTimer);
        clipboardFlyoutLeaveTimer = null;
      }
      clipboardHoverIndex = idx;
      clipboardNavPane = "groups";
      clipboardItemIndex = 0;
      setClipboardGroupIndex(idx);
    });
    li.addEventListener("mouseleave", () => {
      clipboardHoverIndex = null;
      if (clipboardCompact) {
        clearTimeout(clipboardFlyoutLeaveTimer);
        clipboardFlyoutLeaveTimer = setTimeout(() => {
          clipboardFlyoutLeaveTimer = null;
          if (!clipboardFlyoutPeerHover) syncClipboardFlyout();
        }, 280);
      } else {
        setTimeout(() => {
          if (!clipboardFlyoutMouseInside) syncClipboardFlyout();
        }, 100);
      }
    });

    li.addEventListener("click", () => {
      clipboardNavPane = "groups";
      clipboardItemIndex = 0;
      setClipboardGroupIndex(idx);
    });

    clipboardList.appendChild(li);
  });

  setClipboardGroupIndex(clipboardGroupRows.length ? 0 : -1);
  reportClipboardCompactMainHeightIfNeeded();
}

function renderTemplatesList(grouped) {
  clearTimeout(templatesFlyoutLeaveTimer);
  templatesFlyoutLeaveTimer = null;
  templatesFlyoutPeerHover = false;
  hideTemplatesFlyout();
  templateHoverIndex = null;
  templateKeyboardNav = false;
  templatesFlyoutMouseInside = false;
  templateNavPane = "groups";
  templateItemIndex = 0;

  templatesGroupList.innerHTML = "";
  templateGroupRows = [];
  for (const g of grouped || []) {
    const items = g.items || [];
    if (!items.length) continue;
    templateGroupRows.push({ name: g.group || "General", items });
  }

  if (!templateGroupRows.length) {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `<div class="itemText">No templates saved.</div><div class="itemMeta">Switch to Configure to add one.</div>`;
    templatesGroupList.appendChild(li);
    selectedIndex = -1;
    reportTemplatesCompactMainHeightIfNeeded();
    return;
  }

  templateGroupRows.forEach((group, idx) => {
    const li = document.createElement("li");
    li.className = "clip-group-wrap";
    li.dataset.index = String(idx);
    li.setAttribute("role", "option");

    const row = document.createElement("div");
    row.className = "clip-group-row";
    row.innerHTML = `<span>${escapeHtml(group.name)}</span><span class="chevron">›</span>`;
    li.appendChild(row);

    li.addEventListener("mouseenter", () => {
      if (templatesCompact) {
        clearTimeout(templatesFlyoutLeaveTimer);
        templatesFlyoutLeaveTimer = null;
      }
      templateHoverIndex = idx;
      templateNavPane = "groups";
      templateItemIndex = 0;
      setTemplateGroupIndex(idx);
    });
    li.addEventListener("mouseleave", () => {
      templateHoverIndex = null;
      if (templatesCompact) {
        clearTimeout(templatesFlyoutLeaveTimer);
        templatesFlyoutLeaveTimer = setTimeout(() => {
          templatesFlyoutLeaveTimer = null;
          if (!templatesFlyoutPeerHover) syncTemplatesFlyout();
        }, 280);
      } else {
        setTimeout(() => {
          if (!templatesFlyoutMouseInside) syncTemplatesFlyout();
        }, 100);
      }
    });

    li.addEventListener("click", () => {
      templateNavPane = "groups";
      templateItemIndex = 0;
      setTemplateGroupIndex(idx);
    });

    templatesGroupList.appendChild(li);
  });

  setTemplateGroupIndex(0);
  reportTemplatesCompactMainHeightIfNeeded();
}

function renderTemplatesConfigList(allTemplates) {
  templatesConfigList.innerHTML = "";
  const templates = allTemplates || [];

  if (!templates.length) {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `<div class="itemText">No templates yet.</div><div class="itemMeta">Add one using the form above.</div>`;
    templatesConfigList.appendChild(li);
    return;
  }

  templates.forEach((t) => {
    const li = document.createElement("li");
    li.className = "item";
    li.dataset.id = t.id;

    const preview = (t.text || "").replace(/\s+/g, " ").slice(0, 70);
    li.innerHTML = `
      <div class="itemText">${escapeHtml(t.name)}</div>
      <div class="itemMeta">${escapeHtml(t.group || "General")} · ${escapeHtml(preview)}${preview.length >= 70 ? "…" : ""}</div>
    `;

    li.addEventListener("click", () => {
      editingTemplateId = t.id;
      tmplGroup.value = t.group || "";
      tmplName.value = t.name || "";
      tmplText.value = t.text || "";
      clearStatus();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn secondary";
    del.textContent = "Delete";
    del.style.flex = "0";
    del.style.marginTop = "8px";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.deleteTemplate(t.id).then(() => {
        // Refresh by re-rendering list via existing update payload.
        return refreshTemplatesConfig();
      });
    });

    // Small UI hack: append delete button in the meta area by adding it after li.innerHTML.
    li.appendChild(del);
    templatesConfigList.appendChild(li);
  });
}

function refreshTemplatesConfig() {
  return api.getTemplatesAll().then((all) => {
    lastTemplatesAll = all;
    const grouped = groupTemplatesForLocal(all);
    lastTemplatesGrouped = grouped;
    renderTemplatesConfigList(all);
    if (uiMode === "templates" && templateView === "list") {
      renderTemplatesList(grouped);
    }
  });
}

function focusPanelKeyboardTarget() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (uiMode === "clipboard" && clipboardSection && !clipboardSection.classList.contains("hidden")) {
        clipboardList.focus();
      } else if (
        uiMode === "templates" &&
        templateView === "list" &&
        templatesListWrap &&
        !templatesListWrap.classList.contains("hidden")
      ) {
        templatesGroupList.focus();
      } else if (uiMode === "todos" && todosSection && !todosSection.classList.contains("hidden")) {
        if (todoInput) todoInput.focus();
      } else if (
        uiMode === "todosToday" &&
        todosTodaySection &&
        !todosTodaySection.classList.contains("hidden")
      ) {
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        const todayScroll = document.querySelector(".todos-today-scroll");
        if (todayScroll) todayScroll.scrollTop = 0;
        if (todosTodayQuickInput) todosTodayQuickInput.focus({ preventScroll: true });
      } else if (
        uiMode === "todoQuickAdd" &&
        todoQuickAddSection &&
        !todoQuickAddSection.classList.contains("hidden")
      ) {
        if (todoQuickInput) todoQuickInput.focus();
      } else if (uiMode === "info" && infoSection && !infoSection.classList.contains("hidden")) {
        if (infoScroll) infoScroll.focus({ preventScroll: true });
      } else if (uiMode === "settings" && settingsSection && !settingsSection.classList.contains("hidden")) {
        const first = settingsSection.querySelector("input, button, select, textarea");
        if (first) first.focus();
      }
    });
  });
}

function setTemplateView(next) {
  templateView = next;
  if (next === "list") {
    listModeBtn.classList.add("active");
    configModeBtn.classList.remove("active");
    templatesListWrap.classList.remove("hidden");
    templatesConfigWrap.classList.add("hidden");
    if (uiMode === "templates") {
      const grouped =
        lastTemplatesGrouped && lastTemplatesGrouped.length
          ? lastTemplatesGrouped
          : groupTemplatesForLocal(lastTemplatesAll || []);
      lastTemplatesGrouped = grouped;
      renderTemplatesList(grouped);
    }
  } else {
    listModeBtn.classList.remove("active");
    configModeBtn.classList.add("active");
    templatesListWrap.classList.add("hidden");
    templatesConfigWrap.classList.remove("hidden");
    hideTemplatesFlyout();
  }
  if (next === "list" && uiMode === "templates") {
    focusPanelKeyboardTarget();
  }
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateToYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return dateToYmd(dt);
}

/** Monday–Sunday week (local) that contains today. */
function weekRangeYmd() {
  const now = new Date();
  const dow = now.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: dateToYmd(monday), end: dateToYmd(sunday) };
}

function filterTodosForChip(todos, filter) {
  if (filter === "all") return todos.slice();
  const t0 = todayYmd();
  const t1 = addDaysYmd(t0, 1);
  const { start: w0, end: w1 } = weekRangeYmd();
  const monthPrefix = t0.slice(0, 7);
  return todos.filter((t) => {
    const td = t.targetDate || t0;
    if (filter === "today") return td === t0;
    if (filter === "tomorrow") return td === t1;
    if (filter === "week") return td >= w0 && td <= w1;
    if (filter === "month") return td.slice(0, 7) === monthPrefix;
    return true;
  });
}

function syncTodoChips() {
  const wrap = document.getElementById("todoChips");
  if (!wrap) return;
  wrap.querySelectorAll(".chip[data-filter]").forEach((btn) => {
    const on = btn.dataset.filter === todoFilter;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function sortTodosForDisplay(todos) {
  const list = Array.isArray(todos) ? todos.slice() : [];
  return list.sort((a, b) => {
    const da = a.targetDate || todayYmd();
    const db = b.targetDate || todayYmd();
    if (da !== db) return da.localeCompare(db);
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function sortTodosTodayForPeek(todos) {
  const list = filterTodosForChip(todos, "today");
  return list.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function renderTodosTodayList() {
  if (!todosTodayList) return;
  const visible = sortTodosTodayForPeek(lastTodosFull);
  if (todosTodayDateLabel) {
    todosTodayDateLabel.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  const n = visible.length;
  const undone = visible.filter((t) => !t.done).length;
  if (todosTodayCountEl) {
    if (n === 0) todosTodayCountEl.textContent = "No tasks today";
    else if (undone === 0) todosTodayCountEl.textContent = "All done — nice work";
    else todosTodayCountEl.textContent = `${undone} task${undone === 1 ? "" : "s"} left`;
  }
  todosTodayList.innerHTML = "";
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "todos-today-empty";
    li.innerHTML = `<div class="todos-today-empty-inner">
      <div class="todos-today-empty-ring" aria-hidden="true"></div>
      <p class="todos-today-empty-title">Your day is clear</p>
      <p class="todos-today-empty-sub">Add something below or with ⌘⇧D</p>
    </div>`;
    todosTodayList.appendChild(li);
    return;
  }
  for (const t of visible) {
    const li = document.createElement("li");
    li.className = `todos-today-card${t.done ? " done" : ""}`;
    li.dataset.id = t.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.setAttribute("aria-label", t.done ? "Mark as not done" : "Mark as done");
    cb.addEventListener("change", async () => {
      const res = await api.toggleTodo(t.id);
      if (res?.todos) renderTodosList(res.todos);
    });

    const span = document.createElement("span");
    span.className = "todos-today-card-text";
    span.textContent = t.text;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todos-today-card-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove");
    del.addEventListener("click", async () => {
      const res = await api.deleteTodo(t.id);
      if (res?.todos) renderTodosList(res.todos);
    });

    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(del);
    todosTodayList.appendChild(li);
  }
}

function renderTodoListFromCache() {
  if (!todoList) return;
  const visible = sortTodosForDisplay(filterTodosForChip(lastTodosFull, todoFilter));
  lastTodos = visible;
  todoList.innerHTML = "";
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "item";
    const hasAny = lastTodosFull.length > 0;
    li.innerHTML = hasAny
      ? `<div class="itemText">No tasks match this filter.</div><div class="itemMeta">Try another chip or All.</div>`
      : `<div class="itemText">No tasks yet.</div><div class="itemMeta">Add one above.</div>`;
    todoList.appendChild(li);
    syncTodoChips();
    return;
  }
  syncTodoChips();
  for (const t of visible) {
    const li = document.createElement("li");
    li.className = `todo-row${t.done ? " done" : ""}`;
    li.dataset.id = t.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.setAttribute("aria-label", t.done ? "Mark as not done" : "Mark as done");
    cb.addEventListener("change", async () => {
      const res = await api.toggleTodo(t.id);
      if (res?.todos) renderTodosList(res.todos);
    });

    const span = document.createElement("span");
    span.className = "todo-text";
    span.textContent = t.text;

    const dateIn = document.createElement("input");
    dateIn.type = "date";
    dateIn.className = "input todo-date-inline";
    dateIn.title = "Target date";
    dateIn.setAttribute("aria-label", "Target date");
    dateIn.value = t.targetDate || todayYmd();
    dateIn.addEventListener("change", async () => {
      const res = await api.setTodoDate(t.id, dateIn.value);
      if (res?.todos) renderTodosList(res.todos);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todo-del todo-del-icon";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove");
    del.title = "Remove";
    del.addEventListener("click", async () => {
      const res = await api.deleteTodo(t.id);
      if (res?.todos) renderTodosList(res.todos);
    });

    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(dateIn);
    li.appendChild(del);
    todoList.appendChild(li);
  }
}

function renderTodosList(todos) {
  lastTodosFull = Array.isArray(todos) ? todos.slice() : [];
  renderTodoListFromCache();
  if (uiMode === "todosToday") renderTodosTodayList();
}

async function submitNewTodo() {
  if (!todoInput) return;
  const text = todoInput.value.trim();
  if (!text) return;
  const dateArg = todoDateInput?.value?.trim() || "";
  const res = await api.addTodo(text, dateArg);
  if (res?.ok && res.todos) {
    todoInput.value = "";
    if (todoDateInput) todoDateInput.value = todayYmd();
    renderTodosList(res.todos);
  }
}

function resetTodoFormDefaults() {
  if (todoDateInput) todoDateInput.value = todayYmd();
}

function hideTodoQuickAddSection() {
  if (todoQuickAddSection) {
    todoQuickAddSection.classList.add("hidden");
    todoQuickAddSection.style.display = "none";
  }
  if (rootEl) rootEl.classList.remove("quick-todo");
}

async function submitQuickTodo() {
  if (!todoQuickInput) return;
  const text = todoQuickInput.value.trim();
  if (!text) return;
  const dateArg = todoQuickDate?.value?.trim() || "";
  const res = await api.addTodo(text, dateArg);
  if (res?.ok) {
    api.close();
  }
}

async function submitTodosTodayQuick() {
  if (!todosTodayQuickInput) return;
  const text = todosTodayQuickInput.value.trim();
  if (!text) return;
  const res = await api.addTodo(text, todayYmd());
  if (res?.ok && res.todos) {
    todosTodayQuickInput.value = "";
    renderTodosList(res.todos);
  }
}

function showMode(mode, payload) {
  uiMode = mode;
  selectedIndex = -1;
  if (mode !== "clipboard") {
    try {
      api.clipboardFlyoutHide();
    } catch (_) {
      // ignore
    }
    clearClipboardCompactSizingClasses();
  }
  if (mode !== "templates") {
    try {
      api.templatesFlyoutHide();
    } catch (_) {
      // ignore
    }
    clearTemplatesCompactSizingClasses();
  }
  if (todosTodaySection) {
    todosTodaySection.classList.add("hidden");
    todosTodaySection.style.display = "none";
  }
  if (infoSection) {
    infoSection.classList.add("hidden");
    infoSection.style.display = "none";
  }
  if (rootEl) rootEl.classList.remove("todo-today-peek");

  if (mode === "clipboard") {
    hideTodoQuickAddSection();
    tabClipboard.classList.add("active");
    tabTemplates.classList.remove("active");
    tabTodos.classList.remove("active");
    tabSettings.classList.remove("active");
    clipboardSection.classList.remove("hidden");
    clipboardSection.style.display = "block";
    templatesSection.classList.add("hidden");
    templatesSection.style.display = "none";
    todosSection.classList.add("hidden");
    todosSection.style.display = "none";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";
    modeTitle.textContent = "Clipboard";
    clipboardCompact = !!payload?.compact;
    templatesCompact = false;
    if (rootEl) {
      rootEl.classList.toggle("compact-overlay", clipboardCompact);
      rootEl.classList.toggle("clipboard-compact-dual", clipboardCompact);
      rootEl.classList.remove("templates-compact-dual");
    }
    if (!clipboardCompact) {
      try {
        api.clipboardFlyoutHide();
      } catch (_) {
        // ignore
      }
    }
    if (payload?.settings) {
      lastClipboardSettings = payload.settings;
      applyThemeFromSettings(payload.settings);
    }
    hideTemplatesFlyout();
    renderClipboardList(payload?.clipboardHistory || [], payload?.settings);
    setTemplateView("list");
    focusPanelKeyboardTarget();
    return;
  }

  if (mode === "todoQuickAdd") {
    tabClipboard.classList.remove("active");
    tabTemplates.classList.remove("active");
    tabTodos.classList.remove("active");
    tabSettings.classList.remove("active");
    clipboardSection.classList.add("hidden");
    clipboardSection.style.display = "none";
    templatesSection.classList.add("hidden");
    templatesSection.style.display = "none";
    todosSection.classList.add("hidden");
    todosSection.style.display = "none";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";
    if (todoQuickAddSection) {
      todoQuickAddSection.classList.remove("hidden");
      todoQuickAddSection.style.display = "block";
    }
    modeTitle.textContent = "New task";
    if (rootEl) {
      rootEl.classList.add("quick-todo");
      rootEl.classList.add("compact-overlay");
    }
    if (payload?.settings) applyThemeFromSettings(payload.settings);
    if (todoQuickInput) todoQuickInput.value = "";
    if (todoQuickDate) todoQuickDate.value = todayYmd();
    focusPanelKeyboardTarget();
    return;
  }

  if (mode === "todosToday") {
    hideTodoQuickAddSection();
    tabClipboard.classList.remove("active");
    tabTemplates.classList.remove("active");
    tabTodos.classList.remove("active");
    tabSettings.classList.remove("active");
    clipboardSection.classList.add("hidden");
    clipboardSection.style.display = "none";
    templatesSection.classList.add("hidden");
    templatesSection.style.display = "none";
    todosSection.classList.add("hidden");
    todosSection.style.display = "none";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";
    if (todosTodaySection) {
      todosTodaySection.classList.remove("hidden");
      todosTodaySection.style.display = "flex";
    }
    modeTitle.textContent = "Today";
    if (rootEl) {
      rootEl.classList.add("compact-overlay");
      rootEl.classList.add("todo-today-peek");
    }
    if (payload?.settings) applyThemeFromSettings(payload.settings);
    renderTodosList(payload?.todos || []);
    if (todosTodayQuickInput) todosTodayQuickInput.value = "";
    focusPanelKeyboardTarget();
    return;
  }

  if (rootEl) rootEl.classList.remove("compact-overlay");
  hideClipboardFlyout();
  if (mode !== "templates") hideTemplatesFlyout();
  hideTodoQuickAddSection();
  if (rootEl) {
    rootEl.classList.remove("clipboard-compact-dual", "templates-compact-dual");
  }

  if (mode === "templates") {
    tabTemplates.classList.add("active");
    tabClipboard.classList.remove("active");
    tabTodos.classList.remove("active");
    tabSettings.classList.remove("active");

    templatesCompact = !!payload?.compact;
    clipboardCompact = false;
    if (rootEl) {
      rootEl.classList.toggle("compact-overlay", templatesCompact);
      rootEl.classList.toggle("templates-compact-dual", templatesCompact);
      rootEl.classList.remove("clipboard-compact-dual");
    }
    if (!templatesCompact) {
      try {
        api.templatesFlyoutHide();
      } catch (_) {
        // ignore
      }
    }

    templatesSection.classList.remove("hidden");
    clipboardSection.classList.add("hidden");
    clipboardSection.style.display = "none";
    templatesSection.style.display = "block";
    todosSection.classList.add("hidden");
    todosSection.style.display = "none";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";

    modeTitle.textContent = "Templates";
    lastTemplatesGrouped = payload?.templatesGrouped || [];
    lastTemplatesAll = payload?.templatesAll || [];
    if (payload?.settings) applyThemeFromSettings(payload.settings);
    setTemplateView("list");
    renderTemplatesConfigList(lastTemplatesAll);
    focusPanelKeyboardTarget();
    return;
  }

  if (mode === "todos") {
    tabTodos.classList.add("active");
    tabClipboard.classList.remove("active");
    tabTemplates.classList.remove("active");
    tabSettings.classList.remove("active");

    clipboardSection.classList.add("hidden");
    clipboardSection.style.display = "none";
    templatesSection.classList.add("hidden");
    templatesSection.style.display = "none";
    todosSection.classList.remove("hidden");
    todosSection.style.display = "block";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";

    modeTitle.textContent = "Todos";
    if (payload?.settings) applyThemeFromSettings(payload.settings);
    renderTodosList(payload?.todos || []);
    if (todoInput) todoInput.value = "";
    resetTodoFormDefaults();
    focusPanelKeyboardTarget();
    return;
  }

  if (mode === "info") {
    tabClipboard.classList.remove("active");
    tabTemplates.classList.remove("active");
    tabTodos.classList.remove("active");
    tabSettings.classList.remove("active");

    clipboardSection.classList.add("hidden");
    clipboardSection.style.display = "none";
    templatesSection.classList.add("hidden");
    templatesSection.style.display = "none";
    todosSection.classList.add("hidden");
    todosSection.style.display = "none";
    settingsSection.classList.add("hidden");
    settingsSection.style.display = "none";
    if (infoSection) {
      infoSection.classList.remove("hidden");
      infoSection.style.display = "block";
    }

    modeTitle.textContent = "Info";
    if (payload?.settings) applyThemeFromSettings(payload.settings);
    focusPanelKeyboardTarget();
    return;
  }

  // mode === "settings"
  tabSettings.classList.add("active");
  tabClipboard.classList.remove("active");
  tabTemplates.classList.remove("active");
  tabTodos.classList.remove("active");

  clipboardSection.classList.add("hidden");
  clipboardSection.style.display = "none";
  templatesSection.classList.add("hidden");
  templatesSection.style.display = "none";
  todosSection.classList.add("hidden");
  todosSection.style.display = "none";

  settingsSection.classList.remove("hidden");
  settingsSection.style.display = "block";
  modeTitle.textContent = "Settings";

  const enabled = !!payload?.startupEnabled;
  toggleStartupBtnSettings.dataset.enabled = enabled ? "1" : "0";
  toggleStartupBtnSettings.textContent = enabled ? "Start on login: On" : "Start on login: Off";

  const s = payload?.settings;
  if (s) {
    setClipboardGroups.value = String(s.clipboardGroups ?? "");
    setClipboardPerGroup.value = String(s.clipboardPerGroup ?? "");
    setSavedGroupsMax.value = String(s.savedGroupsMax ?? "");
    setSavedPerGroup.value = String(s.savedPerGroup ?? "");
    if (themeSelect) themeSelect.value = s.theme || "system";
    applyThemeFromSettings(s);
  }
  setSettingsStatus("");
  focusPanelKeyboardTarget();
}

function formatTime(epochMs) {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadStartupToggle() {
  const enabled = await api.getStartupEnabled();
  if (!toggleStartupBtnSettings) return;
  toggleStartupBtnSettings.dataset.enabled = enabled ? "1" : "0";
  toggleStartupBtnSettings.textContent = enabled ? "Start on login: On" : "Start on login: Off";
}

function selectedClipboardText() {
  if (uiMode !== "clipboard") return null;
  const g = clipboardGroupRows[selectedIndex];
  if (!g || !g.entries?.length) return null;
  if (clipboardNavPane === "items") {
    return g.entries[clipboardItemIndex]?.text || null;
  }
  return g.entries[0]?.text || null;
}

function selectedTemplateText() {
  if (uiMode !== "templates" || templateView !== "list") return null;
  const g = templateGroupRows[selectedIndex];
  if (!g || !g.items?.length) return null;
  if (templateNavPane === "items") {
    return g.items[templateItemIndex]?.text || null;
  }
  return g.items[0]?.text || null;
}

async function pasteSelected() {
  const text = selectedClipboardText() || selectedTemplateText();
  if (!text) return;
  await api.paste(text);
}

function onKeyDown(ev) {
  if (uiMode === "todoQuickAdd" && ev.key === "Enter") {
    const t = ev.target;
    if (t === todoQuickInput || t === todoQuickDate) {
      ev.preventDefault();
      submitQuickTodo();
      return;
    }
  }

  if (uiMode === "todosToday" && ev.key === "Enter") {
    const t = ev.target;
    if (t === todosTodayQuickInput) {
      ev.preventDefault();
      submitTodosTodayQuick();
      return;
    }
  }

  if (ev.key === "Escape") {
    if (uiMode === "todoQuickAdd") {
      ev.preventDefault();
      api.close();
      return;
    }
    if (uiMode === "todosToday") {
      ev.preventDefault();
      api.close();
      return;
    }
    if (uiMode === "clipboard" && clipboardNavPane === "items") {
      ev.preventDefault();
      clipboardNavPane = "groups";
      clipboardItemIndex = 0;
      syncClipboardFlyout();
      return;
    }
    if (uiMode === "templates" && templateView === "list" && templateNavPane === "items") {
      ev.preventDefault();
      templateNavPane = "groups";
      templateItemIndex = 0;
      syncTemplatesFlyout();
      return;
    }
    hideClipboardFlyout();
    hideTemplatesFlyout();
    api.close();
    return;
  }

  if (uiMode === "clipboard" && clipboardGroupRows.length) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
      ev.preventDefault();
      clipboardKeyboardNav = true;
      const maxG = clipboardGroupRows.length - 1;
      if (clipboardNavPane === "groups") {
        if (ev.key === "ArrowUp") {
          setClipboardGroupIndex(Math.max(0, selectedIndex - 1));
        } else if (ev.key === "ArrowDown") {
          setClipboardGroupIndex(Math.min(maxG, selectedIndex + 1));
        } else if (ev.key === "ArrowRight") {
          const g = clipboardGroupRows[selectedIndex];
          if (g?.entries?.length) {
            clipboardNavPane = "items";
            clipboardItemIndex = 0;
            syncClipboardFlyout();
          }
        }
      } else {
        const g = clipboardGroupRows[selectedIndex];
        const n = g?.entries?.length || 0;
        if (ev.key === "ArrowUp") {
          clipboardItemIndex = Math.max(0, clipboardItemIndex - 1);
          syncClipboardFlyout();
        } else if (ev.key === "ArrowDown") {
          clipboardItemIndex = Math.min(n - 1, clipboardItemIndex + 1);
          syncClipboardFlyout();
        } else if (ev.key === "ArrowLeft") {
          clipboardNavPane = "groups";
          clipboardItemIndex = 0;
          syncClipboardFlyout();
        }
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      pasteSelected();
      return;
    }
    return;
  }

  if (uiMode === "templates" && templateView === "list" && templateGroupRows.length) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
      ev.preventDefault();
      templateKeyboardNav = true;
      const maxG = templateGroupRows.length - 1;
      if (templateNavPane === "groups") {
        if (ev.key === "ArrowUp") {
          setTemplateGroupIndex(Math.max(0, selectedIndex - 1));
        } else if (ev.key === "ArrowDown") {
          setTemplateGroupIndex(Math.min(maxG, selectedIndex + 1));
        } else if (ev.key === "ArrowRight") {
          const g = templateGroupRows[selectedIndex];
          if (g?.items?.length) {
            templateNavPane = "items";
            templateItemIndex = 0;
            syncTemplatesFlyout();
          }
        }
      } else {
        const g = templateGroupRows[selectedIndex];
        const n = g?.items?.length || 0;
        if (ev.key === "ArrowUp") {
          templateItemIndex = Math.max(0, templateItemIndex - 1);
          syncTemplatesFlyout();
        } else if (ev.key === "ArrowDown") {
          templateItemIndex = Math.min(n - 1, templateItemIndex + 1);
          syncTemplatesFlyout();
        } else if (ev.key === "ArrowLeft") {
          templateNavPane = "groups";
          templateItemIndex = 0;
          syncTemplatesFlyout();
        }
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      pasteSelected();
      return;
    }
    return;
  }
}

function wireUI() {
  closeBtn.addEventListener("click", () => api.close());

  tabClipboard.addEventListener("click", () => {
    Promise.all([api.getClipboardHistory(), api.getSettings()]).then(([hist, settings]) => {
      showMode("clipboard", { clipboardHistory: hist, settings, compact: false });
    });
  });

  tabTemplates.addEventListener("click", () => {
    api.getSettings().then((settings) => {
      showMode("templates", {
        templatesGrouped: lastTemplatesGrouped,
        templatesAll: lastTemplatesAll,
        settings,
        compact: false,
      });
    });
  });

  tabTodos.addEventListener("click", () => {
    Promise.all([api.getTodos(), api.getSettings()]).then(([todos, settings]) => {
      showMode("todos", { todos, settings });
    });
  });

  tabSettings.addEventListener("click", () => {
    Promise.all([api.getStartupEnabled(), api.getSettings()]).then(([startupEnabled, settings]) => {
      showMode("settings", { startupEnabled, settings });
    });
  });

  listModeBtn.addEventListener("click", () => setTemplateView("list"));
  configModeBtn.addEventListener("click", () => setTemplateView("configure"));

  saveTemplateBtn.addEventListener("click", async () => {
    clearStatus();
    saveTemplateBtn.disabled = true;
    saveTemplateBtn.textContent = "Saving...";
    try {
      const group = tmplGroup.value;
      const name = tmplName.value;
      const text = tmplText.value;
      const res = await api.saveTemplate({ group, name, text });
      if (!res?.ok) {
        setStatus(res?.error || "Failed to save template.");
        return;
      }
      setStatus("Saved.");
      const all = await api.getTemplatesAll();
      renderTemplatesConfigList(all);
      lastTemplatesAll = all;
      // If currently in list view, refresh the list for immediate feedback.
      if (uiMode === "templates" && templateView === "list") {
        const grouped = groupTemplatesForLocal(all);
        renderTemplatesList(grouped);
        lastTemplatesGrouped = grouped;
      }
    } finally {
      saveTemplateBtn.disabled = false;
      saveTemplateBtn.textContent = "Save";
    }
  });

  document.addEventListener("keydown", onKeyDown);

  if (api.onClipboardFlyoutPeerHover) {
    api.onClipboardFlyoutPeerHover((inside) => {
      clipboardFlyoutPeerHover = !!inside;
      if (inside) {
        clearTimeout(clipboardFlyoutLeaveTimer);
        clipboardFlyoutLeaveTimer = null;
      }
    });
  }

  if (api.onClipboardFlyoutSyncDone) {
    api.onClipboardFlyoutSyncDone(() => {
      if (uiMode === "clipboard" && clipboardCompact && clipboardList) {
        clipboardList.focus();
      }
    });
  }

  if (api.onClipboardCompactMainSized) {
    api.onClipboardCompactMainSized(() => {
      if (uiMode === "clipboard" && clipboardCompact) {
        document.documentElement.classList.add("clipboard-compact-main-sized");
        if (rootEl) rootEl.classList.add("clipboard-compact-dual--locked");
      } else if (uiMode === "templates" && templatesCompact) {
        document.documentElement.classList.add("templates-compact-main-sized");
        if (rootEl) rootEl.classList.add("templates-compact-dual--locked");
      }
    });
  }

  if (api.onTemplatesFlyoutPeerHover) {
    api.onTemplatesFlyoutPeerHover((inside) => {
      templatesFlyoutPeerHover = !!inside;
      if (inside) {
        clearTimeout(templatesFlyoutLeaveTimer);
        templatesFlyoutLeaveTimer = null;
      }
    });
  }

  if (api.onTemplatesFlyoutSyncDone) {
    api.onTemplatesFlyoutSyncDone(() => {
      if (uiMode === "templates" && templatesCompact && templatesGroupList) {
        templatesGroupList.focus();
      }
    });
  }

  if (clipboardFlyout) {
    clipboardFlyout.addEventListener("mouseenter", () => {
      clipboardFlyoutMouseInside = true;
    });
    clipboardFlyout.addEventListener("mouseleave", () => {
      clipboardFlyoutMouseInside = false;
      clipboardHoverIndex = null;
      setTimeout(() => syncClipboardFlyout(), 50);
    });
  }

  if (templatesFlyout) {
    templatesFlyout.addEventListener("mouseenter", () => {
      templatesFlyoutMouseInside = true;
    });
    templatesFlyout.addEventListener("mouseleave", () => {
      templatesFlyoutMouseInside = false;
      templateHoverIndex = null;
      setTimeout(() => syncTemplatesFlyout(), 50);
    });
  }

  const todoChips = document.getElementById("todoChips");
  if (todoChips) {
    todoChips.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".chip[data-filter]");
      if (!btn) return;
      const f = btn.dataset.filter;
      if (!TODO_FILTER_IDS.has(f) || f === todoFilter) return;
      todoFilter = f;
      renderTodoListFromCache();
    });
  }

  if (todoAddBtn) todoAddBtn.addEventListener("click", () => submitNewTodo());
  if (todoInput) {
    todoInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitNewTodo();
      }
    });
  }
  if (todoClearDoneBtn) {
    todoClearDoneBtn.addEventListener("click", async () => {
      const res = await api.clearDoneTodos();
      if (res?.todos) renderTodosList(res.todos);
    });
  }

  if (todosTodayAddBtn) todosTodayAddBtn.addEventListener("click", () => submitTodosTodayQuick());

  if (themeSelect) {
    themeSelect.addEventListener("change", async () => {
      try {
        const next = await api.setSettings({ theme: themeSelect.value });
        applyThemeFromSettings(next);
      } catch (_) {
        // ignore
      }
    });
  }

  toggleStartupBtnSettings.addEventListener("click", async () => {
    const currentlyEnabled = toggleStartupBtnSettings.dataset.enabled === "1";
    const next = !currentlyEnabled;
    await api.setStartupEnabled(next);
    await loadStartupToggle();
  });

  saveSettingsBtn.addEventListener("click", async () => {
    setSettingsStatus("");
    saveSettingsBtn.disabled = true;
    saveSettingsBtn.textContent = "Saving...";
    try {
      const partial = {
        clipboardGroups: Number(setClipboardGroups.value),
        clipboardPerGroup: Number(setClipboardPerGroup.value),
        savedGroupsMax: Number(setSavedGroupsMax.value),
        savedPerGroup: Number(setSavedPerGroup.value),
        ...(themeSelect ? { theme: themeSelect.value } : {}),
      };
      const final = await api.setSettings(partial);
      setClipboardGroups.value = String(final.clipboardGroups);
      setClipboardPerGroup.value = String(final.clipboardPerGroup);
      setSavedGroupsMax.value = String(final.savedGroupsMax);
      setSavedPerGroup.value = String(final.savedPerGroup);
      setSettingsStatus("Saved.");
      if (uiMode === "clipboard") {
        const hist = await api.getClipboardHistory();
        renderClipboardList(hist, final);
      }
    } catch (e) {
      setSettingsStatus("Failed to save settings.");
    } finally {
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = "Save settings";
    }
  });
}

function groupTemplatesForLocal(allTemplates) {
  const groups = new Map();
  for (const t of allTemplates || []) {
    const g = (t.group || "").trim() || "General";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const out = [];
  for (const [group, items] of groups.entries()) {
    out.push({ group, items });
  }
  return out;
}

wireUI();
loadStartupToggle();

api.getSettings().then((s) => {
  if (themeSelect) themeSelect.value = s.theme || "system";
  applyThemeFromSettings(s);
});

api.onThemeChange(({ effective }) => {
  if (effective === "light" || effective === "dark") applyTheme(effective);
});

api.onUiUpdate((payload) => {
  showMode(payload.mode, payload);
});

