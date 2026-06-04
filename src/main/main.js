const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  clipboard,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  Notification,
  powerMonitor,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const AutoLaunch = require("auto-launch");

const APP_NAME = "ClipNinja";
// Must stay in sync with template textarea maxlength in src/renderer/index.html (saved clips + paste).
const MAX_TEXT_CHARS = 25000;
const MAX_TODO_TEXT = 500;
const MAX_TODOS = 500;
/** Quick-add (Cmd+Shift+D): tight height; width = 8× height (wide strip). */
const QUICK_TODO_INPUT_LINE_HEIGHT = 39; // ~50% taller than previous 26px row
const QUICK_TODO_CONTENT_PAD_V = 8 + 8;
const QUICK_TODO_PANEL_HEIGHT = QUICK_TODO_INPUT_LINE_HEIGHT + QUICK_TODO_CONTENT_PAD_V;
const QUICK_TODO_PANEL_WIDTH = QUICK_TODO_PANEL_HEIGHT * 8;
/** Option+Shift+D: compact “today” focus panel. */
const TODOS_TODAY_PANEL_WIDTH = 340;
const TODOS_TODAY_PANEL_HEIGHT = 420;
/** Cmd+Shift+V / Cmd+Shift+B (compact): group list only; items pane is a separate adjacent window */
const CLIPBOARD_COMPACT_MAIN_WIDTH = 140;
/** Secondary window (clipboard clips + SavedClip items); shared width for both. */
const CLIPBOARD_COMPACT_FLYOUT_WIDTH = 228;
/** Until renderer reports measured height */
const CLIPBOARD_COMPACT_MIN_HEIGHT = 96;
const CLIPBOARD_COMPACT_MAX_HEIGHT = 560;
const CLIPBOARD_FLYOUT_GAP = 6;
const LIMIT_MAX_GROUPS = 20;
const LIMIT_MAX_PER_GROUP = 20;

const DEFAULT_SETTINGS = Object.freeze({
  clipboardGroups: 10,
  clipboardPerGroup: 10,
  savedGroupsMax: 10,
  savedPerGroup: 10,
  theme: "system",
  /** Open today's todo panel after macOS login / unlock (default on). */
  openTodosTodayOnLogin: true,
});

let store = null;

async function initStore() {
  const StoreMod = await import("electron-store");
  const StoreCtor = StoreMod?.default || StoreMod;
  store = new StoreCtor({
    name: "clipninja",
    defaults: {
      clipboardHistory: [],
      templates: [],
      todos: [],
      startupEnabled: false,
      settings: DEFAULT_SETTINGS,
    },
  });
}

let panelWindow = null;
/** Second window: clipboard item list (compact shortcut only) */
let clipboardFlyoutWindow = null;
/** Second window: SavedClip template items (Cmd+Shift+B compact only) */
let templatesFlyoutWindow = null;

/** Mouse is over the separate items window (non-focusable); do not dismiss when the main panel blurs. */
let clipboardFlyoutPeerHoverMain = false;
let templatesFlyoutPeerHoverMain = false;

/** Blur/focus races on macOS: same-tick getFocusedWindow() can be stale; debounce dismiss. */
let hidePanelBlurTimer = null;
const PANEL_BLUR_DISMISS_MS = 140;

/** When true, we route keyboard nav via temporary globalShortcuts (no app activation). */
let overlayNavEnabled = false;
let overlayNavRegistered = false;
let overlayNavEnabledAt = 0;

const OVERLAY_NAV_ACCELS = ["Up", "Down", "Left", "Right", "Escape", "Enter", "Return", "E"];

function sendOverlayNavKey(key) {
  if (!overlayNavEnabled || !overlayNavRegistered) return;
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) {
    disableOverlayNavShortcuts();
    return;
  }
  if (currentMode !== "clipboard" && currentMode !== "templates") return;
  const k = String(key || "");
  // Ignore Enter briefly after registering so a queued/repeated key cannot paste into the front app.
  if (k === "Enter" && Date.now() - overlayNavEnabledAt < 280) return;
  try {
    panelWindow.webContents.send("ui:nav-key", { key: k });
  } catch (_) {
    // ignore
  }
}

function unregisterOverlayNavShortcuts() {
  for (const a of OVERLAY_NAV_ACCELS) {
    try {
      globalShortcut.unregister(a);
    } catch (_) {
      // ignore
    }
  }
  overlayNavRegistered = false;
}

function disableOverlayNavShortcuts() {
  overlayNavEnabled = false;
  unregisterOverlayNavShortcuts();
}

function enableOverlayNavShortcuts() {
  unregisterOverlayNavShortcuts();
  if (!overlayNavEnabled) return;
  // Register only while our overlay is visible; avoid stealing focus by keeping ClipNinja inactive.
  // These shortcuts override arrow keys globally, so keep the scope as narrow as possible.
  const bindings = [
    ["Up", "ArrowUp"],
    ["Down", "ArrowDown"],
    ["Left", "ArrowLeft"],
    ["Right", "ArrowRight"],
    ["Escape", "Escape"],
    ["Enter", "Enter"],
    ["Return", "Enter"],
    ["E", "E"],
  ];
  let okAny = false;
  for (const [accel, key] of bindings) {
    try {
      const ok = globalShortcut.register(accel, () => sendOverlayNavKey(key));
      okAny = okAny || ok;
    } catch (_) {
      // ignore
    }
  }
  overlayNavRegistered = okAny;
  if (okAny) overlayNavEnabledAt = Date.now();
}
let currentMode = "clipboard"; // 'clipboard' | 'templates' | 'todos' | 'settings' | 'todoQuickAdd' | 'todosToday'
let uiUpdatePending = null;

/** macOS: unix PID of the app that was frontmost when a global shortcut opened the panel (for paste target). */
let lastFrontmostPid = null;

/**
 * macOS: last PID seen as frontmost that is not ClipNinja (polled). Sync capture often sees Electron
 * because the global shortcut can activate this app before we query System Events.
 */
let lastSeenForeignFrontmostPid = null;
let frontmostPollInterval = null;

/** Log once when macOS blocks Apple Events to System Events (-1743). */
let warnedAutomationPermission = false;
/** One-time Notification so the user knows which binary to allow (Electron vs packaged name). */
let warnedAutomationNotification = false;

let tray = null;
/** Cached menu-bar icon source (before badge overlay). */
let trayIconBase = null;

function warnAutomationOnce(detail) {
  if (warnedAutomationPermission) return;
  warnedAutomationPermission = true;
  const devHint = app.isPackaged
    ? ""
    : ` When developing (npm start), macOS shows the app as Electron, not ${APP_NAME}. Allow Electron → System Events. Path: ${process.execPath}`;
  console.warn(
    "[ClipNinja] macOS blocked AppleScript → System Events (e.g. -1743). " +
      "System Settings → Privacy & Security → Automation → enable System Events for this app. " +
      (app.isPackaged ? "Packaged app name: " + APP_NAME + ". " : "Dev: look for Electron. ") +
      (detail || "") +
      devHint,
  );
}

function notifyAutomationPermissionOnce() {
  if (warnedAutomationNotification || !Notification.isSupported()) return;
  warnedAutomationNotification = true;
  try {
    const body = app.isPackaged
      ? `Open System Settings → Privacy & Security → Automation. Turn on System Events for ${APP_NAME}. Until then, copied text is on the clipboard — press Cmd+V in your field.`
      : `You run from source: macOS lists this app as "Electron", not ${APP_NAME}. Open System Settings → Privacy & Security → Automation → Electron → turn on System Events. If Electron is missing, run ClipNinja once and approve the prompt, or add the app at:\n${process.execPath}\nUntil allowed, use Cmd+V after copy.`;
    new Notification({
      title: `${APP_NAME} — allow Automation`,
      body,
    }).show();
  } catch (_) {
    // ignore
  }
}

/** Dev: explain why only Cursor appears under Automation and how to get Electron listed. */
function logDevMacPastePermissionHints() {
  if (app.isPackaged || process.platform !== "darwin") return;
  const exe = process.execPath;
  const appBundleMatch = exe.match(/^(.*\/Electron\.app)\//);
  const electronAppPath = appBundleMatch ? appBundleMatch[1] : exe;
}

/**
 * Run osascript; stderr is captured (not printed) so -1743 does not flood the terminal.
 * @returns {{ ok: boolean, stdout: string }}
 */
function runOsascriptSync(args) {
  try {
    const stdout = execFileSync("osascript", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || "") };
  } catch (e) {
    const stderr = e.stderr ? (Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr)) : "";
    const msg = `${stderr} ${e?.message || e || ""}`;
    const isAuthDenied =
      process.platform === "darwin" &&
      (msg.includes("-1743") || msg.includes("Not authorised") || msg.includes("Not authorized"));
    if (isAuthDenied) {
      if (frontmostPollInterval) {
        clearInterval(frontmostPollInterval);
        frontmostPollInterval = null;
      }
      warnAutomationOnce("Until then, text is copied to the clipboard — use Cmd+V to paste.");
      notifyAutomationPermissionOnce();
    }
    return { ok: false, stdout: "" };
  }
}

function tickMacFrontmostPoll() {
  if (process.platform !== "darwin") return;
  const r = runOsascriptSync(["-e", 'tell application "System Events" to get unix id of first process whose frontmost is true']);
  if (!r.ok) return;
  const pid = parseInt(String(r.stdout).trim(), 10);
  if (Number.isFinite(pid) && pid !== process.pid) {
    lastSeenForeignFrontmostPid = pid;
  }
}

function captureFrontmostPidSync() {
  if (process.platform !== "darwin") {
    lastFrontmostPid = null;
    return;
  }
  const r = runOsascriptSync(["-e", 'tell application "System Events" to get unix id of first process whose frontmost is true']);
  let target = null;
  if (r.ok) {
    const pid = parseInt(String(r.stdout).trim(), 10);
    if (Number.isFinite(pid) && pid !== process.pid) {
      target = pid;
      lastSeenForeignFrontmostPid = pid;
    }
  }
  if (target == null) {
    target = lastSeenForeignFrontmostPid;
  }
  lastFrontmostPid = target;
}

function isFrontmostAppFullScreenSync() {
  if (process.platform !== "darwin") return false;
  // Best-effort: when a fullscreen app is frontmost, activating another app can jump Spaces.
  // If this query fails (accessibility/automation), fall back to normal behavior.
  const r = runOsascriptSync([
    "-e",
    [
      'tell application "System Events"',
      "  try",
      "    set frontProc to first process whose frontmost is true",
      "    set frontWin to first window of frontProc",
      '    set isFs to value of attribute "AXFullScreen" of frontWin',
      "    return isFs as boolean",
      "  on error",
      "    return false",
      "  end try",
      "end tell",
    ].join("\n"),
  ]);
  const out = String(r.stdout || "").trim().toLowerCase();
  return r.ok && (out === "true" || out === "yes" || out === "1");
}

function activatePidSync(pid) {
  if (!pid || process.platform !== "darwin") return;
  const safe = parseInt(String(pid), 10);
  if (!Number.isFinite(safe)) return;
  runOsascriptSync([
    "-e",
    `tell application "System Events" to set frontmost of first process whose unix id is ${safe} to true`,
  ]);
}

/** macOS: NSPasteboard.generalPasteboard — some targets read this more reliably than Electron alone. */
function macPbcopySync(text) {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("pbcopy", { input: Buffer.from(String(text), "utf8"), stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (_) {
    return false;
  }
}

function macOsascriptGlobalCmdV() {
  return runOsascriptSync([
    "-e",
    'tell application "System Events" to keystroke "v" using {command down}',
  ]);
}

function macOsascriptGlobalKeyCodeV() {
  return runOsascriptSync([
    "-e",
    'tell application "System Events" to key code 9 using {command down}',
  ]);
}

/**
 * One osascript round-trip: frontmost target process → short delay → Cmd+V.
 * Faster than separate activate + second script (avoids double execFileSync / Apple event latency).
 */
function macPasteFastPid(safePid) {
  if (process.platform !== "darwin" || !safePid || !Number.isFinite(safePid) || safePid === process.pid) {
    return { ok: false };
  }
  const script = [
    'tell application "System Events"',
    `  tell (first process whose unix id is ${safePid})`,
    "    set frontmost to true",
    "    delay 0.055",
    "  end tell",
    '  keystroke "v" using {command down}',
    "end tell",
  ].join("\n");
  return runOsascriptSync(["-e", script]);
}

/** Slower fallback: activate by app name (better for some browsers) then paste. */
function macPasteActivateThenCmdV(safePid) {
  const myPid = process.pid;
  if (process.platform !== "darwin" || !safePid || !Number.isFinite(safePid) || safePid === myPid) {
    return { ok: false };
  }
  const script = [
    'tell application "System Events"',
    `  set pn to name of first process whose unix id is ${safePid}`,
    "end tell",
    "try",
    "  tell application pn to activate",
    "on error",
    `    tell application "System Events" to set frontmost of first process whose unix id is ${safePid} to true`,
    "end try",
    "delay 0.12",
    'tell application "System Events" to keystroke "v" using {command down}',
  ].join("\n");
  return runOsascriptSync(["-e", script]);
}

function createSvgImages(svgText) {
  const svg = String(svgText);
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return [
    { dataUrl: `data:image/svg+xml;base64,${base64}`, label: "base64" },
    { dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, label: "charset" },
  ];
}

function createNativeImageFromSvg(svgText) {
  const variants = createSvgImages(svgText);
  for (const v of variants) {
    try {
      const img = nativeImage.createFromDataURL(v.dataUrl);
      if (img && !img.isEmpty()) return img;
    } catch (e) {
      // Try next variant
    }
  }
  return null;
}

function ensurePngIconExists() {
  const svgPath = path.join(__dirname, "..", "..", "assets", "icon.svg");
  const pngPath = path.join(__dirname, "..", "..", "assets", "icon.png");

  if (fs.existsSync(pngPath)) return pngPath;

  try {
    console.log("Generating tray/Dock icon.png from icon.svg via sips...");
    // sips can rasterize SVG on macOS, which Electron tray prefers over SVG.
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
    return pngPath;
  } catch (e) {
    // If conversion fails, let callers fall back to other icons.
    console.error("Failed to generate icon.png via sips:", e?.message || e);
    return pngPath;
  }
}

function sanitizeForMenuLabel(s) {
  const str = String(s ?? "");
  const oneLine = str.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

function loadTrayIconBase() {
  if (trayIconBase && !trayIconBase.isEmpty()) return trayIconBase;

  const pngPath = ensurePngIconExists();
  let icon = nativeImage.createFromPath(pngPath);

  if (!icon || icon.isEmpty()) {
    const svgPath = path.join(__dirname, "..", "..", "assets", "icon.svg");
    const svgText = fs.readFileSync(svgPath, "utf8");
    icon = createNativeImageFromSvg(svgText);
  }

  if (!icon || icon.isEmpty()) return null;
  trayIconBase = icon;
  return trayIconBase;
}

const TRAY_ICON_LOGICAL_PX = 22;
/** Menu-bar icon scale (1 = full; 0.8 = 80% of current rendered size). */
const TRAY_ICON_MENU_SCALE = 0.8;
/** Badge dot scale relative to the previous dot size. */
const TRAY_BADGE_DOT_SCALE = 0.5;

function getTrayDisplayScaleFactor() {
  return screen.getPrimaryDisplay().scaleFactor || 1;
}

function getTrayIconPixelSize() {
  const scaled = TRAY_ICON_LOGICAL_PX * TRAY_ICON_MENU_SCALE;
  return Math.max(Math.round(scaled), Math.round(scaled * getTrayDisplayScaleFactor()));
}

function setBitmapPixel(buffer, width, height, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  buffer[i] = b;
  buffer[i + 1] = g;
  buffer[i + 2] = r;
  buffer[i + 3] = a;
}

function paintDotOnBitmap(buffer, width, height, cx, cy, radius, rgb) {
  const [r, g, b] = rgb;
  const r2 = radius * radius;
  const ring = Math.max(0.6, radius * 0.35);
  const outerR = radius + ring;
  const y0 = Math.max(0, Math.floor(cy - outerR));
  const y1 = Math.min(height - 1, Math.ceil(cy + outerR));
  const x0 = Math.max(0, Math.floor(cx - outerR));
  const x1 = Math.min(width - 1, Math.ceil(cx + outerR));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= outerR * outerR) {
        if (dist2 <= r2) {
          setBitmapPixel(buffer, width, height, x, y, r, g, b, 255);
        } else {
          setBitmapPixel(buffer, width, height, x, y, 255, 255, 255, 220);
        }
      }
    }
  }
}

function getTodoTrayBadgeState() {
  const today = todayLocalYmd();
  let hasTodayRemaining = false;
  let hasPastRemaining = false;
  for (const t of getTodos()) {
    if (t.done) continue;
    const d = t.targetDate || today;
    if (d === today) hasTodayRemaining = true;
    else if (d < today) hasPastRemaining = true;
  }
  return { hasTodayRemaining, hasPastRemaining };
}

function trayImageFromBitmapBuffer(buf, width, height) {
  // scaleFactor 1: use full pixel buffer in the menu bar (matches pre-badge icon size on Retina).
  return nativeImage.createFromBitmap(buf, { width, height, scaleFactor: 1 });
}

function buildTrayImageWithBadges(hasTodayRemaining, hasPastRemaining) {
  const base = loadTrayIconBase();
  if (!base) return null;

  const size = getTrayIconPixelSize();
  const img = base.resize({ width: size, height: size });
  const { width, height } = img.getSize();
  const buf = Buffer.from(img.toBitmap());
  if (buf.length < width * height * 4) {
    return trayImageFromBitmapBuffer(buf, width, height);
  }

  if (hasPastRemaining || hasTodayRemaining) {
    const dotR = Math.max(2, Math.round(size * 0.065 * TRAY_BADGE_DOT_SCALE));
    // Sit on the artwork corners (icon PNG has transparent top/side padding in the tray bitmap).
    const dotCy = Math.min(height - dotR - 1, Math.round(height * 0.2) + dotR);
    const dotCxLeft = dotR;
    const dotCxRight = width - dotR;

    if (hasPastRemaining) {
      paintDotOnBitmap(buf, width, height, dotCxLeft, dotCy, dotR, [0, 122, 255]);
    }
    if (hasTodayRemaining) {
      paintDotOnBitmap(buf, width, height, dotCxRight, dotCy, dotR, [48, 209, 88]);
    }
  }

  return trayImageFromBitmapBuffer(buf, width, height);
}

function refreshTrayIcon() {
  if (!tray) return;
  try {
    const { hasTodayRemaining, hasPastRemaining } = getTodoTrayBadgeState();
    const icon = buildTrayImageWithBadges(hasTodayRemaining, hasPastRemaining);
    if (icon && !icon.isEmpty()) tray.setImage(icon);

    let tip = APP_NAME;
    if (hasTodayRemaining) tip += " — tasks due today";
    else if (hasPastRemaining) tip += " — overdue tasks";
    tray.setToolTip(tip);
  } catch (e) {
    console.error("Failed to update tray icon badges:", e);
  }
}

function refreshTrayMenuIfReady() {
  if (!tray) return;
  try {
    refreshTrayIcon();
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    console.error("Failed to refresh tray menu:", e);
  }
}

function buildClipboardSubmenu() {
  const items = getClipboardHistory() || [];
  if (!items.length) {
    return [{ label: "No clipboard history yet", enabled: false }];
  }

  const settings = getSettings();
  const submenu = [{ label: "Open Clipboard UI", click: () => ensurePanelVisible("clipboard", { compact: false }) }, { type: "separator" }];

  for (let gi = 0; gi < settings.clipboardGroups; gi++) {
    const start = gi * settings.clipboardPerGroup;
    const chunk = items.slice(start, start + settings.clipboardPerGroup);
    submenu.push({
      label: `Clip${gi + 1}`,
      submenu: chunk.length
        ? chunk.map((entry) => ({
            label: sanitizeForMenuLabel(entry.text),
            click: async () => {
              await pasteText(entry.text);
              if (panelWindow) panelWindow.hide();
            },
          }))
        : [{ label: "(empty)", enabled: false }],
    });
  }

  return submenu;
}

function buildSavedClipSubmenu() {
  const groups = groupTemplates(enforceSavedClipLimits(getTemplates() || []));
  if (!groups.length) {
    return [{ label: "No templates saved yet", enabled: false }];
  }

  const submenu = [{ label: "Open SavedClip UI", click: () => ensurePanelVisible("templates") }, { type: "separator" }];

  for (const g of groups) {
    const groupLabel = g.group || "General";
    submenu.push({
      label: groupLabel,
      submenu: (g.items || []).length
        ? (g.items || []).map((t) => {
            const textPreview = sanitizeForMenuLabel(t.text || "");
            const namePreview = sanitizeForMenuLabel(t.name || "");
            const label =
              namePreview && textPreview ? `${namePreview} · ${textPreview}` : namePreview || textPreview || "Template";
            return {
              label,
              click: async () => {
                await pasteText(t.text || "");
                if (panelWindow) panelWindow.hide();
              },
            };
          })
        : [{ label: "(empty)", enabled: false }],
    });
  }

  return submenu;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Clipboard",
      submenu: buildClipboardSubmenu(),
    },
    { type: "separator" },
    {
      label: "SavedClip",
      submenu: buildSavedClipSubmenu(),
    },
    { type: "separator" },
    {
      label: "Todos",
      click: () => ensurePanelVisible("todos"),
    },
    {
      label: "Quick add todo",
      click: () => ensurePanelVisible("todoQuickAdd", { compact: true }),
    },
    {
      label: "Today's todos",
      click: () => ensurePanelVisible("todosToday", { compact: true }),
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => ensurePanelVisible("settings"),
    },
    {
      label: "Info",
      click: () => ensurePanelVisible("info"),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
}

function setDockIcon() {
  try {
    if (!app.dock || typeof app.dock.setIcon !== "function") return;
    const pngPath = ensurePngIconExists();
    const img = nativeImage.createFromPath(pngPath);
    if (img && !img.isEmpty()) {
      app.dock.setIcon(img.resize({ width: 64, height: 64 }));
      return;
    }

    // Fallback so Dock icon is never missing.
    const svgPath = path.join(__dirname, "..", "..", "assets", "icon.svg");
    const svgText = fs.readFileSync(svgPath, "utf8");
    const svgImg = createNativeImageFromSvg(svgText);
    if (svgImg && !svgImg.isEmpty()) app.dock.setIcon(svgImg.resize({ width: 64, height: 64 }));
  } catch (e) {
    console.error("Failed to set Dock icon:", e);
  }
}

// Prevent feedback loop: when we paste, clipboard changes too.
let suppressClipboardEvent = false;
let lastClipboardText = "";
let clipboardPollInterval = null;

let startupLauncher = null;

function normalizeText(input) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_TEXT_CHARS) return trimmed.slice(0, MAX_TEXT_CHARS);
  return trimmed;
}

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(String(n), 10);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function normalizeThemePreference(raw) {
  const t = typeof raw === "string" ? raw.toLowerCase() : "";
  if (t === "dark" || t === "light" || t === "system") return t;
  return DEFAULT_SETTINGS.theme;
}

function getSettings() {
  const raw = store?.get("settings", {}) || {};
  return {
    clipboardGroups: clampInt(raw.clipboardGroups, 1, LIMIT_MAX_GROUPS, DEFAULT_SETTINGS.clipboardGroups),
    clipboardPerGroup: clampInt(raw.clipboardPerGroup, 1, LIMIT_MAX_PER_GROUP, DEFAULT_SETTINGS.clipboardPerGroup),
    savedGroupsMax: clampInt(raw.savedGroupsMax, 1, LIMIT_MAX_GROUPS, DEFAULT_SETTINGS.savedGroupsMax),
    savedPerGroup: clampInt(raw.savedPerGroup, 1, LIMIT_MAX_PER_GROUP, DEFAULT_SETTINGS.savedPerGroup),
    theme: normalizeThemePreference(raw.theme),
    openTodosTodayOnLogin: raw.openTodosTodayOnLogin !== false,
  };
}

/** Resolved UI theme for window chrome and renderer. */
function getEffectiveTheme() {
  const pref = getSettings().theme;
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  try {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  } catch (_) {
    return "dark";
  }
}

function panelBackgroundHex() {
  return getEffectiveTheme() === "light" ? "#f4f6fa" : "#0b0f17";
}

function sendThemeToPanel() {
  const preference = getSettings().theme;
  const effective = getEffectiveTheme();
  const payload = { preference, effective };
  if (panelWindow && !panelWindow.isDestroyed()) {
    try {
      panelWindow.webContents.send("theme:update", payload);
    } catch (_) {
      // ignore
    }
  }
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed()) {
    try {
      clipboardFlyoutWindow.webContents.send("theme:update", payload);
    } catch (_) {
      // ignore
    }
  }
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed()) {
    try {
      templatesFlyoutWindow.webContents.send("theme:update", payload);
    } catch (_) {
      // ignore
    }
  }
}

function applyPanelChromeTheme() {
  const bg = panelBackgroundHex();
  if (panelWindow && !panelWindow.isDestroyed()) {
    try {
      panelWindow.setBackgroundColor(bg);
    } catch (_) {
      // ignore
    }
  }
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed()) {
    try {
      clipboardFlyoutWindow.setBackgroundColor(bg);
    } catch (_) {
      // ignore
    }
  }
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed()) {
    try {
      templatesFlyoutWindow.setBackgroundColor(bg);
    } catch (_) {
      // ignore
    }
  }
}

function getMaxClipboardItems(settings = getSettings()) {
  return settings.clipboardGroups * settings.clipboardPerGroup;
}

function enforceSavedClipLimits(templates, settings = getSettings()) {
  const byGroup = new Map();
  for (const t of templates || []) {
    const g = (t.group || "").trim() || "General";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(t);
  }

  for (const [g, list] of byGroup.entries()) {
    list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    byGroup.set(g, list.slice(0, settings.savedPerGroup));
  }

  const groupsSorted = Array.from(byGroup.entries()).sort((a, b) => {
    const aNewest = a[1]?.[0];
    const bNewest = b[1]?.[0];
    const aTs = aNewest ? aNewest.updatedAt || aNewest.createdAt || 0 : 0;
    const bTs = bNewest ? bNewest.updatedAt || bNewest.createdAt || 0 : 0;
    return bTs - aTs;
  });

  const allowed = groupsSorted.slice(0, settings.savedGroupsMax);
  const flattened = [];
  for (const [, list] of allowed) flattened.push(...list);
  flattened.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return flattened;
}

function setSettings(partial) {
  const current = getSettings();
  const merged = { ...current, ...(partial || {}) };
  const next = {
    clipboardGroups: clampInt(merged.clipboardGroups, 1, LIMIT_MAX_GROUPS, DEFAULT_SETTINGS.clipboardGroups),
    clipboardPerGroup: clampInt(merged.clipboardPerGroup, 1, LIMIT_MAX_PER_GROUP, DEFAULT_SETTINGS.clipboardPerGroup),
    savedGroupsMax: clampInt(merged.savedGroupsMax, 1, LIMIT_MAX_GROUPS, DEFAULT_SETTINGS.savedGroupsMax),
    savedPerGroup: clampInt(merged.savedPerGroup, 1, LIMIT_MAX_PER_GROUP, DEFAULT_SETTINGS.savedPerGroup),
    theme: normalizeThemePreference(merged.theme),
    openTodosTodayOnLogin: merged.openTodosTodayOnLogin !== false,
  };

  store.set("settings", next);

  // Trim clipboard to x*y
  const clipped = (getClipboardHistory() || []).slice(0, getMaxClipboardItems(next));
  setClipboardHistory(clipped);

  // Enforce SavedClip limits
  const templates = enforceSavedClipLimits(getTemplates() || [], next);
  store.set("templates", templates);

  refreshTrayMenuIfReady();
  sendThemeToPanel();
  applyPanelChromeTheme();
  return next;
}

function getClipboardHistory() {
  return store.get("clipboardHistory", []);
}

function setClipboardHistory(history) {
  store.set("clipboardHistory", history);
}

function addToClipboardHistory(text) {
  const normalized = normalizeText(text);
  if (!normalized) return;

  const maxItems = getMaxClipboardItems();
  const existing = getClipboardHistory();
  // Dedupe by exact text match, newest first.
  const deduped = existing.filter((x) => x.text !== normalized);
  const next = [{ id: cryptoRandomId(), text: normalized, copiedAt: Date.now() }, ...deduped];
  setClipboardHistory(next.slice(0, maxItems));
  refreshTrayMenuIfReady();
}

function cryptoRandomId() {
  // Simple ID for persistence; avoids adding another dependency.
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function getTemplates() {
  return store.get("templates", []);
}

function setTemplates(templates) {
  store.set("templates", templates);
  refreshTrayMenuIfReady();
}

function normalizeTodoText(input) {
  const t = typeof input === "string" ? input.trim() : "";
  if (!t) return "";
  return t.length > MAX_TODO_TEXT ? t.slice(0, MAX_TODO_TEXT) : t;
}

function todayLocalYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @returns {string} YYYY-MM-DD in local calendar; invalid/empty → today */
function normalizeTargetDateYmd(input) {
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    const t = input.trim();
    const [yy, mm, dd] = t.split("-").map(Number);
    const test = new Date(yy, mm - 1, dd);
    if (
      test.getFullYear() === yy &&
      test.getMonth() === mm - 1 &&
      test.getDate() === dd
    ) {
      return t;
    }
  }
  return todayLocalYmd();
}

function getTodos() {
  const raw = store.get("todos", []) || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const text = normalizeTodoText(r?.text || "");
      if (!text || typeof r?.id !== "string" || !r.id) return null;
      return {
        id: r.id,
        text,
        done: !!r.done,
        createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
        targetDate: normalizeTargetDateYmd(r?.targetDate),
      };
    })
    .filter(Boolean);
}

function setTodos(todos) {
  store.set("todos", Array.isArray(todos) ? todos.slice(0, MAX_TODOS) : []);
  refreshTrayMenuIfReady();
}

function groupTemplates(templates) {
  const groups = new Map();
  for (const t of templates) {
    const g = (t.group || "").trim() || "General";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const g of groups.keys()) {
    groups.get(g).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

function createPanelWindow() {
  if (panelWindow) return panelWindow;

  let windowIcon = undefined;
  try {
    const pngPath = ensurePngIconExists();
    if (pngPath && fs.existsSync(pngPath)) {
      const img = nativeImage.createFromPath(pngPath);
      if (img && !img.isEmpty()) windowIcon = img;
    }
  } catch (_) {
    // ignore
  }

  panelWindow = new BrowserWindow({
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    ...(windowIcon ? { icon: windowIcon } : {}),
    width: 420,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    transparent: false,
    backgroundColor: panelBackgroundHex(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Float above normal windows (cannot draw inside other apps — this mimics a lightweight overlay).
  if (process.platform === "darwin") {
    try {
      panelWindow.setAlwaysOnTop(true, "floating");
      panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {
      panelWindow.setAlwaysOnTop(true);
    }
  }

  panelWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  panelWindow.webContents.once("did-finish-load", () => {
    sendThemeToPanel();
    if (uiUpdatePending) {
      panelWindow.webContents.send("ui:update", uiUpdatePending);
      uiUpdatePending = null;
    }
  });

  panelWindow.on("closed", () => {
    panelWindow = null;
  });

  panelWindow.on("blur", () => {
    onPanelOrFlyoutBlur();
  });

  panelWindow.on("hide", () => {
    disableOverlayNavShortcuts();
  });

  return panelWindow;
}

function hideClipboardFlyoutWindow() {
  clipboardFlyoutPeerHoverMain = false;
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed()) {
    try {
      clipboardFlyoutWindow.hide();
    } catch (_) {
      // ignore
    }
  }
}

function hideTemplatesFlyoutWindow() {
  templatesFlyoutPeerHoverMain = false;
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed()) {
    try {
      templatesFlyoutWindow.hide();
    } catch (_) {
      // ignore
    }
  }
}

function isOurPanelOrFlyoutWindow(win) {
  if (!win || win.isDestroyed()) return false;
  return (
    win === panelWindow ||
    win === clipboardFlyoutWindow ||
    win === templatesFlyoutWindow
  );
}

function cancelPendingPanelBlurDismiss() {
  if (hidePanelBlurTimer) {
    clearTimeout(hidePanelBlurTimer);
    hidePanelBlurTimer = null;
  }
}

/** Settings (tray → Settings) stays open until the user closes it or switches mode. */
function isSettingsPanelSticky() {
  return (
    currentMode === "settings" &&
    panelWindow &&
    !panelWindow.isDestroyed() &&
    panelWindow.isVisible()
  );
}

function hidePanelAndFlyoutsIfNoFocus() {
  if (isSettingsPanelSticky()) return;

  const focused = BrowserWindow.getFocusedWindow();
  if (isOurPanelOrFlyoutWindow(focused)) return;
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isFocused()) return;
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed() && clipboardFlyoutWindow.isFocused()) return;
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed() && templatesFlyoutWindow.isFocused()) return;

  // Peer-hover blocks dismiss so the panel can blur while the pointer moves to the non-focusable
  // flyout. If focus left ClipNinja entirely, mouseleave may never run — stale true would keep the
  // flyout open for hours.
  if (!focused || !isOurPanelOrFlyoutWindow(focused)) {
    clipboardFlyoutPeerHoverMain = false;
    templatesFlyoutPeerHoverMain = false;
  }

  if (clipboardFlyoutPeerHoverMain && clipboardFlyoutWindow && clipboardFlyoutWindow.isVisible()) return;
  if (templatesFlyoutPeerHoverMain && templatesFlyoutWindow && templatesFlyoutWindow.isVisible()) return;
  hideClipboardFlyoutWindow();
  hideTemplatesFlyoutWindow();
  if (panelWindow && !panelWindow.isDestroyed()) {
    try {
      panelWindow.hide();
    } catch (_) {
      // ignore
    }
  }
  disableOverlayNavShortcuts();
}

function scheduleHidePanelIfLostFocus() {
  if (isSettingsPanelSticky()) return;
  cancelPendingPanelBlurDismiss();
  hidePanelBlurTimer = setTimeout(() => {
    hidePanelBlurTimer = null;
    hidePanelAndFlyoutsIfNoFocus();
  }, PANEL_BLUR_DISMISS_MS);
}

function onPanelOrFlyoutBlur() {
  if (isSettingsPanelSticky()) return;
  scheduleHidePanelIfLostFocus();
}

function setupPanelBlurDismiss() {
  app.on("browser-window-blur", (_event, win) => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    if (!isOurPanelOrFlyoutWindow(win)) return;
    const anyOursVisible =
      panelWindow.isVisible() ||
      (clipboardFlyoutWindow &&
        !clipboardFlyoutWindow.isDestroyed() &&
        clipboardFlyoutWindow.isVisible()) ||
      (templatesFlyoutWindow &&
        !templatesFlyoutWindow.isDestroyed() &&
        templatesFlyoutWindow.isVisible());
    if (!anyOursVisible) return;
    if (isSettingsPanelSticky()) return;
    scheduleHidePanelIfLostFocus();
  });
  app.on("browser-window-focus", (_event, win) => {
    if (!isOurPanelOrFlyoutWindow(win)) return;
    cancelPendingPanelBlurDismiss();
  });
}

function positionClipboardFlyoutWindow() {
  if (!panelWindow || panelWindow.isDestroyed() || !clipboardFlyoutWindow || clipboardFlyoutWindow.isDestroyed()) {
    return;
  }
  const b = panelWindow.getBounds();
  const fw = clipboardFlyoutWindow.getBounds().width;
  const fh = clipboardFlyoutWindow.getBounds().height;
  let left = b.x + b.width + CLIPBOARD_FLYOUT_GAP;
  let top = b.y;
  const display = screen.getDisplayNearestPoint({ x: left, y: top });
  const wa = display.workArea;
  if (left + fw > wa.x + wa.width - 4) {
    left = b.x - CLIPBOARD_FLYOUT_GAP - fw;
  }
  if (left < wa.x + 4) left = wa.x + 4;
  if (top + fh > wa.y + wa.height - 4) top = wa.y + wa.height - fh - 8;
  if (top < wa.y + 4) top = wa.y + 4;
  clipboardFlyoutWindow.setPosition(Math.floor(left), Math.floor(top));
}

function positionTemplatesFlyoutWindow() {
  if (!panelWindow || panelWindow.isDestroyed() || !templatesFlyoutWindow || templatesFlyoutWindow.isDestroyed()) {
    return;
  }
  const b = panelWindow.getBounds();
  const fw = templatesFlyoutWindow.getBounds().width;
  const fh = templatesFlyoutWindow.getBounds().height;
  let left = b.x + b.width + CLIPBOARD_FLYOUT_GAP;
  let top = b.y;
  const display = screen.getDisplayNearestPoint({ x: left, y: top });
  const wa = display.workArea;
  if (left + fw > wa.x + wa.width - 4) {
    left = b.x - CLIPBOARD_FLYOUT_GAP - fw;
  }
  if (left < wa.x + 4) left = wa.x + 4;
  if (top + fh > wa.y + wa.height - 4) top = wa.y + wa.height - fh - 8;
  if (top < wa.y + 4) top = wa.y + 4;
  templatesFlyoutWindow.setPosition(Math.floor(left), Math.floor(top));
}

function createClipboardFlyoutWindow() {
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed()) return clipboardFlyoutWindow;

  let windowIcon = undefined;
  try {
    const pngPath = ensurePngIconExists();
    if (pngPath && fs.existsSync(pngPath)) {
      const img = nativeImage.createFromPath(pngPath);
      if (img && !img.isEmpty()) windowIcon = img;
    }
  } catch (_) {
    // ignore
  }

  clipboardFlyoutWindow = new BrowserWindow({
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    ...(windowIcon ? { icon: windowIcon } : {}),
    width: CLIPBOARD_COMPACT_FLYOUT_WIDTH,
    height: CLIPBOARD_COMPACT_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    transparent: false,
    /** Keep keyboard focus on the main panel so ↑↓←→ continue to work */
    focusable: false,
    backgroundColor: panelBackgroundHex(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (process.platform === "darwin") {
    try {
      clipboardFlyoutWindow.setAlwaysOnTop(true, "floating");
      clipboardFlyoutWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {
      clipboardFlyoutWindow.setAlwaysOnTop(true);
    }
  }

  clipboardFlyoutWindow.loadFile(path.join(__dirname, "..", "renderer", "clipboard-flyout.html"));
  clipboardFlyoutWindow.webContents.once("did-finish-load", () => {
    sendThemeToPanel();
  });

  clipboardFlyoutWindow.on("closed", () => {
    clipboardFlyoutWindow = null;
  });

  clipboardFlyoutWindow.on("blur", () => {
    onPanelOrFlyoutBlur();
  });

  return clipboardFlyoutWindow;
}

function createTemplatesFlyoutWindow() {
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed()) return templatesFlyoutWindow;

  let windowIcon = undefined;
  try {
    const pngPath = ensurePngIconExists();
    if (pngPath && fs.existsSync(pngPath)) {
      const img = nativeImage.createFromPath(pngPath);
      if (img && !img.isEmpty()) windowIcon = img;
    }
  } catch (_) {
    // ignore
  }

  templatesFlyoutWindow = new BrowserWindow({
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    ...(windowIcon ? { icon: windowIcon } : {}),
    width: CLIPBOARD_COMPACT_FLYOUT_WIDTH,
    height: CLIPBOARD_COMPACT_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    transparent: false,
    focusable: false,
    backgroundColor: panelBackgroundHex(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (process.platform === "darwin") {
    try {
      templatesFlyoutWindow.setAlwaysOnTop(true, "floating");
      templatesFlyoutWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {
      templatesFlyoutWindow.setAlwaysOnTop(true);
    }
  }

  templatesFlyoutWindow.loadFile(path.join(__dirname, "..", "renderer", "templates-flyout.html"));
  templatesFlyoutWindow.webContents.once("did-finish-load", () => {
    sendThemeToPanel();
  });

  templatesFlyoutWindow.on("closed", () => {
    templatesFlyoutWindow = null;
  });

  templatesFlyoutWindow.on("blur", () => {
    onPanelOrFlyoutBlur();
  });

  return templatesFlyoutWindow;
}

function positionPanelNearCursor() {
  if (!panelWindow) return;
  const { width, height } = panelWindow.getBounds();
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  let left = point.x + 12;
  let top = point.y + 8;
  if (left + width > wa.x + wa.width - 4) left = wa.x + wa.width - width - 8;
  if (top + height > wa.y + wa.height - 4) top = wa.y + wa.height - height - 8;
  if (left < wa.x + 4) left = wa.x + 4;
  if (top < wa.y + 4) top = wa.y + 4;
  panelWindow.setPosition(Math.floor(left), Math.floor(top));
}

function positionPanelWindow(opts = {}) {
  if (!panelWindow) return;
  if (opts.fromShortcut) {
    positionPanelNearCursor();
    return;
  }
  const { width, height } = panelWindow.getBounds();
  const display = screen.getPrimaryDisplay();
  const bounds = display.workArea;
  const targetX = Math.max(bounds.x + 10, bounds.x + bounds.width - width - 10);
  const targetY = Math.max(bounds.y + 10, bounds.y + 10);
  panelWindow.setPosition(targetX, targetY);
}

function ensurePanelVisible(mode, opts = {}) {
  currentMode = mode;
  if (mode === "settings") cancelPendingPanelBlurDismiss();
  const win = createPanelWindow();
  const compact = !!opts.compact;
  const fromShortcut = !!opts.fromShortcut;

  if (mode !== "clipboard") hideClipboardFlyoutWindow();
  if (mode !== "templates") hideTemplatesFlyoutWindow();
  overlayNavEnabled = process.platform === "darwin" && fromShortcut && (mode === "clipboard" || mode === "templates");

  // Tray / non-shortcut opens: do not restore an old PID on paste.
  if (!fromShortcut) {
    lastFrontmostPid = null;
  }

  // Shortcut overlay sizes: clipboard/templates use one size; quick todo add is smaller.
  if (fromShortcut) {
    if (mode === "todoQuickAdd") {
      win.setSize(QUICK_TODO_PANEL_WIDTH, QUICK_TODO_PANEL_HEIGHT);
    } else if (mode === "todosToday") {
      win.setSize(TODOS_TODAY_PANEL_WIDTH, TODOS_TODAY_PANEL_HEIGHT);
    } else if (mode === "clipboard") {
      win.setSize(CLIPBOARD_COMPACT_MAIN_WIDTH, CLIPBOARD_COMPACT_MIN_HEIGHT);
    } else if (mode === "templates" && compact) {
      win.setSize(CLIPBOARD_COMPACT_MAIN_WIDTH, CLIPBOARD_COMPACT_MIN_HEIGHT);
    } else {
      win.setSize(280, 420);
    }
  } else if (mode === "clipboard" && compact) {
    win.setSize(210, 400);
  } else if (mode === "clipboard") {
    win.setSize(420, 560);
  } else if (mode === "todoQuickAdd") {
    win.setSize(QUICK_TODO_PANEL_WIDTH, QUICK_TODO_PANEL_HEIGHT);
  } else if (mode === "todosToday") {
    win.setSize(TODOS_TODAY_PANEL_WIDTH, TODOS_TODAY_PANEL_HEIGHT);
  } else if (mode === "templates" || mode === "todos" || mode === "settings" || mode === "info") {
    win.setSize(420, 560);
  }

  positionPanelWindow({ fromShortcut });
  if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed() && clipboardFlyoutWindow.isVisible()) {
    positionClipboardFlyoutWindow();
  }
  if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed() && templatesFlyoutWindow.isVisible()) {
    positionTemplatesFlyoutWindow();
  }

  const payload = buildModePayload(mode);
  const pasteOnClick =
    !!fromShortcut && (mode === "clipboard" || mode === "templates");
  const message = { mode, ...payload, compact, pasteOnClick };
  if (win.webContents.isLoading()) uiUpdatePending = message;
  else win.webContents.send("ui:update", message);

  if (!win.isVisible()) {
    // On macOS, activating this app can switch Spaces / steal focus (notably from Chrome).
    // Prefer showing inactive for global shortcuts so the current app stays active.
    const shouldShowInactive =
      process.platform === "darwin" &&
      fromShortcut &&
      (mode === "clipboard" || mode === "templates") &&
      typeof win.showInactive === "function";
    if (shouldShowInactive) {
      win.showInactive();
    } else {
      win.show();
    }
  }
  // When shown inactive, the panel won't receive key events until clicked.
  const shouldAvoidActivation =
    process.platform === "darwin" &&
    fromShortcut &&
    (mode === "clipboard" || mode === "templates") &&
    typeof win.showInactive === "function";
  if (!shouldAvoidActivation) {
    // Focus must move to ClipNinja so arrow keys navigate the overlay; paste still targets the
    // app captured in captureFrontmostPidSync() before this window was shown.
    win.focus();
    try {
      win.webContents.focus();
    } catch (_) {
      // ignore
    }
    if (process.platform === "darwin" && typeof app.focus === "function") {
      app.focus({ steal: true });
    }
  }
  enableOverlayNavShortcuts();
}

function openTemplatesEditor(templateId) {
  currentMode = "templates";
  overlayNavEnabled = false;
  disableOverlayNavShortcuts();
  hideClipboardFlyoutWindow();
  hideTemplatesFlyoutWindow();

  const win = createPanelWindow();
  win.setSize(480, 680);
  positionPanelWindow({ fromShortcut: false });

  const payload = buildModePayload("templates");
  const message = {
    mode: "templates",
    ...payload,
    compact: false,
    pasteOnClick: false,
    editTemplateId: templateId || null,
  };
  if (win.webContents.isLoading()) uiUpdatePending = message;
  else win.webContents.send("ui:update", message);

  if (!win.isVisible()) win.show();
  win.focus();
  try {
    win.webContents.focus();
  } catch (_) {
    // ignore
  }
  if (process.platform === "darwin" && typeof app.focus === "function") {
    app.focus({ steal: true });
  }
}

function buildModePayload(mode) {
  if (mode === "clipboard") {
    return {
      clipboardHistory: getClipboardHistory(),
      settings: getSettings(),
    };
  }

  if (mode === "templates") {
    return {
      templatesGrouped: groupTemplates(getTemplates()),
      templatesFlat: flattenTemplatesForUI(getTemplates()),
      templatesAll: getTemplates(),
      settings: getSettings(),
    };
  }

  if (mode === "todos") {
    return {
      todos: getTodos(),
      settings: getSettings(),
    };
  }

  if (mode === "todosToday") {
    return {
      todos: getTodos(),
      settings: getSettings(),
    };
  }

  if (mode === "todoQuickAdd") {
    return {
      settings: getSettings(),
    };
  }

  if (mode === "info") {
    return {
      settings: getSettings(),
    };
  }

  // mode === "settings"
  return {
    startupEnabled: store?.get("startupEnabled", false) || false,
    settings: getSettings(),
  };
}

function flattenTemplatesForUI(templates) {
  // For keyboard navigation.
  return templates
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

async function pasteText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return;

  disableOverlayNavShortcuts();

  if (panelWindow) {
    panelWindow.hide();
  }
  hideClipboardFlyoutWindow();

  const pid = lastFrontmostPid;
  const myPid = process.pid;

  // Keep suppression through hide/activate/paste so the poll cannot race with pasteboard contents.
  suppressClipboardEvent = true;
  lastClipboardText = normalized;
  clipboard.writeText(normalized);
  const clearSuppress = setTimeout(() => {
    suppressClipboardEvent = false;
  }, 4000);

  await new Promise((r) => setImmediate(r));

  if (process.platform === "darwin") {
    const safePid = pid != null && Number.isFinite(Number(pid)) ? parseInt(String(pid), 10) : null;

    try {
      if (typeof app.hide === "function") {
        app.hide();
      }
    } catch (_) {
      // ignore
    }

    await new Promise((r) => setTimeout(r, 8));

    lastClipboardText = normalized;
    clipboard.writeText(normalized);
    macPbcopySync(normalized);

    let pasteKey = { ok: false };
    if (safePid && safePid !== myPid) {
      pasteKey = macPasteFastPid(safePid);
    }
    if (!pasteKey.ok && safePid && safePid !== myPid) {
      pasteKey = macPasteActivateThenCmdV(safePid);
    }
    if (!pasteKey.ok) {
      if (safePid && safePid !== myPid) {
        activatePidSync(safePid);
        await new Promise((r) => setTimeout(r, 35));
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
      lastClipboardText = normalized;
      clipboard.writeText(normalized);
      macPbcopySync(normalized);
      pasteKey = macOsascriptGlobalCmdV();
    }
    if (!pasteKey.ok) {
      pasteKey = macOsascriptGlobalKeyCodeV();
    }

    clearTimeout(clearSuppress);
    suppressClipboardEvent = false;

    if (!pasteKey.ok && Notification.isSupported()) {
      try {
        const devBody =
          `Automation: enable System Events for Electron (not only Cursor). Accessibility: turn Cursor ON if you use npm from Cursor.\n${process.execPath}`;
        new Notification({
          title: APP_NAME,
          body: app.isPackaged
            ? safePid && safePid !== myPid
              ? "Copied to clipboard — click your text field and press Cmd+V to paste."
              : "Copied to clipboard. Allow Automation for System Events, or press Cmd+V to paste."
            : `Paste script failed. ${devBody}`,
        }).show();
      } catch (_) {
        // ignore
      }
    }
    return;
  }

  if (pid) {
    activatePidSync(pid);
  }
  await new Promise((r) => setTimeout(r, 90));

  const pasteKey = runOsascriptSync([
    "-e",
    'tell application "System Events" to keystroke "v" using {command down}',
  ]);
  clearTimeout(clearSuppress);
  suppressClipboardEvent = false;
  if (!pasteKey.ok) {
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: APP_NAME,
          body: "Copied to clipboard. Automation is blocked — press Cmd+V to paste, or allow Automation in System Settings.",
        }).show();
      } catch (_) {
        // ignore
      }
    }
  }
}

let lastOpenTodosTodayOnLoginAt = 0;
let openTodosTodayOnLoginTimer = null;

function getMacBootSessionId() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
  } catch (_) {
    return "";
  }
}

function scheduleOpenTodosTodayOnLogin(reason) {
  if (!getSettings().openTodosTodayOnLogin) return;
  if (openTodosTodayOnLoginTimer) clearTimeout(openTodosTodayOnLoginTimer);
  openTodosTodayOnLoginTimer = setTimeout(() => {
    openTodosTodayOnLoginTimer = null;
    openTodosTodayOnLoginNow(reason);
  }, 1200);
}

function openTodosTodayOnLoginNow(reason) {
  if (!getSettings().openTodosTodayOnLogin) return;

  const now = Date.now();
  if (now - lastOpenTodosTodayOnLoginAt < 2500) return;
  lastOpenTodosTodayOnLoginAt = now;

  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible() && currentMode === "todosToday") {
    return;
  }

  if (reason === "launch") {
    const bootId = getMacBootSessionId();
    if (bootId) {
      const seen = store?.get("lastTodosTodayOpenBootSession", "");
      if (seen === bootId) return;
      store.set("lastTodosTodayOpenBootSession", bootId);
    }
  }

  ensurePanelVisible("todosToday", { compact: true, fromShortcut: false });
}

function setupOpenTodosTodayOnLoginWatchers() {
  if (process.platform !== "darwin") return;

  powerMonitor.on("unlock-screen", () => {
    scheduleOpenTodosTodayOnLogin("unlock");
  });

  powerMonitor.on("resume", () => {
    scheduleOpenTodosTodayOnLogin("resume");
  });
}

function setupClipboardListener() {
  if (clipboardPollInterval) clearInterval(clipboardPollInterval);

  try {
    lastClipboardText = clipboard.readText() || "";
  } catch {
    lastClipboardText = "";
  }

  clipboardPollInterval = setInterval(() => {
    if (suppressClipboardEvent) return;

    let text = "";
    try {
      text = clipboard.readText() || "";
    } catch {
      return;
    }

    if (!text.trim()) return;
    if (text === lastClipboardText) return;

    lastClipboardText = text;
    addToClipboardHistory(text);
  }, 600);
}

function setupGlobalShortcuts() {
  // Cmd+Shift+V: show clipboard list
  // Cmd+Shift+B: show templates list
  // Option+Shift+D: today's todo list (Alt = Option on macOS)
  const okToday = globalShortcut.register("Alt+Shift+D", () => {
    ensurePanelVisible("todosToday", { fromShortcut: true, compact: true });
  });

  // Cmd+Shift+D: quick add todo
  const okV = globalShortcut.register("Command+Shift+V", () => {
    captureFrontmostPidSync();
    ensurePanelVisible("clipboard", { fromShortcut: true, compact: true });
  });
  const okB = globalShortcut.register("Command+Shift+B", () => {
    captureFrontmostPidSync();
    ensurePanelVisible("templates", { fromShortcut: true, compact: true });
  });
  const okD = globalShortcut.register("Command+Shift+D", () => {
    ensurePanelVisible("todoQuickAdd", { fromShortcut: true, compact: true });
  });

  if (!okV) console.warn("Failed to register Command+Shift+V (may be blocked by macOS).");
  else console.log("Shortcut registered: Cmd+Shift+V");
  if (!okB) console.warn("Failed to register Command+Shift+B (may be blocked by macOS).");
  else console.log("Shortcut registered: Cmd+Shift+B");
  if (!okD) console.warn("Failed to register Command+Shift+D (may be blocked by macOS).");
  else console.log("Shortcut registered: Cmd+Shift+D (quick add todo)");
  if (!okToday) console.warn("Failed to register Alt+Shift+D (may be blocked by macOS).");
  else console.log("Shortcut registered: Opt+Shift+D (today's todos)");
}

function setupStartupLauncher() {
  startupLauncher = new AutoLaunch({
    name: APP_NAME,
    // Works in dev and in packaged apps.
    path: process.execPath,
  });

  // Best-effort; auto-launch may require a fresh permission prompt.
  startupLauncher.isEnabled()
    .then((enabled) => {
      const desired = store.get("startupEnabled", false);
      if (enabled !== desired) {
        return desired ? startupLauncher.enable() : startupLauncher.disable();
      }
      return null;
    })
    .catch(() => {});
}

function clampClipboardCompactHeight(h) {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n)) return CLIPBOARD_COMPACT_MIN_HEIGHT;
  return Math.max(CLIPBOARD_COMPACT_MIN_HEIGHT, Math.min(CLIPBOARD_COMPACT_MAX_HEIGHT, n));
}

function bindIpc() {
  ipcMain.handle("data:getStartupEnabled", () => store.get("startupEnabled", false));

  ipcMain.handle("data:setStartupEnabled", async (_evt, enabled) => {
    store.set("startupEnabled", !!enabled);
    if (!startupLauncher) return enabled;
    try {
      if (enabled) await startupLauncher.enable();
      else await startupLauncher.disable();
    } catch (e) {
      console.error("Failed to set startup:", e);
    }
    return enabled;
  });

  ipcMain.on("ui:close", () => {
    hideClipboardFlyoutWindow();
    hideTemplatesFlyoutWindow();
    if (panelWindow && panelWindow.isVisible()) panelWindow.hide();
    overlayNavEnabled = false;
    disableOverlayNavShortcuts();
  });

  ipcMain.on("ui:set-panel-mode", (_evt, { mode } = {}) => {
    if (typeof mode !== "string" || !mode) return;
    currentMode = mode;
    if (mode === "settings") cancelPendingPanelBlurDismiss();
  });

  ipcMain.on("ui:open-templates-editor", (_evt, { id } = {}) => {
    openTemplatesEditor(id);
  });

  ipcMain.on("clipboard-flyout:sync", (_evt, payload) => {
    if (!payload || !payload.show) {
      hideClipboardFlyoutWindow();
      return;
    }
    const fw = createClipboardFlyoutWindow();
    positionClipboardFlyoutWindow();
    if (!fw.isVisible()) {
      if (typeof fw.showInactive === "function") {
        fw.showInactive();
      } else {
        fw.show();
      }
    }
    try {
      fw.webContents.send("clipboard-flyout:render", payload);
    } catch (_) {
      // ignore
    }
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        panelWindow.focus();
        panelWindow.webContents.focus();
        panelWindow.webContents.send("clipboard-flyout:sync-done");
      } catch (_) {
        // ignore
      }
    }
  });

  ipcMain.on("clipboard-flyout:hide", () => {
    hideClipboardFlyoutWindow();
  });

  ipcMain.on("clipboard-flyout:peer-hover", (_e, inside) => {
    clipboardFlyoutPeerHoverMain = !!inside;
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        panelWindow.webContents.send("clipboard-flyout:peer-hover", inside);
      } catch (_) {
        // ignore
      }
    }
  });

  ipcMain.on("templates-flyout:sync", (_evt, payload) => {
    if (!payload || !payload.show) {
      hideTemplatesFlyoutWindow();
      return;
    }
    const fw = createTemplatesFlyoutWindow();
    positionTemplatesFlyoutWindow();
    if (!fw.isVisible()) {
      if (typeof fw.showInactive === "function") {
        fw.showInactive();
      } else {
        fw.show();
      }
    }
    try {
      fw.webContents.send("templates-flyout:render", payload);
    } catch (_) {
      // ignore
    }
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        panelWindow.focus();
        panelWindow.webContents.focus();
        panelWindow.webContents.send("templates-flyout:sync-done");
      } catch (_) {
        // ignore
      }
    }
  });

  ipcMain.on("templates-flyout:hide", () => {
    hideTemplatesFlyoutWindow();
  });

  ipcMain.on("templates-flyout:peer-hover", (_e, inside) => {
    templatesFlyoutPeerHoverMain = !!inside;
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        panelWindow.webContents.send("templates-flyout:peer-hover", inside);
      } catch (_) {
        // ignore
      }
    }
  });

  ipcMain.on("clipboard-compact:resize-main", (_evt, height) => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const h = clampClipboardCompactHeight(height);
    try {
      panelWindow.setSize(CLIPBOARD_COMPACT_MAIN_WIDTH, h);
      positionPanelNearCursor();
      if (clipboardFlyoutWindow && !clipboardFlyoutWindow.isDestroyed() && clipboardFlyoutWindow.isVisible()) {
        positionClipboardFlyoutWindow();
      }
      if (templatesFlyoutWindow && !templatesFlyoutWindow.isDestroyed() && templatesFlyoutWindow.isVisible()) {
        positionTemplatesFlyoutWindow();
      }
      panelWindow.webContents.send("clipboard-compact:main-sized");
    } catch (_) {
      // ignore
    }
  });

  ipcMain.on("clipboard-compact:resize-flyout", (_evt, height) => {
    const h = clampClipboardCompactHeight(height);
    const fw = currentMode === "templates" ? templatesFlyoutWindow : clipboardFlyoutWindow;
    if (!fw || fw.isDestroyed()) return;
    try {
      fw.setSize(CLIPBOARD_COMPACT_FLYOUT_WIDTH, h);
      if (currentMode === "templates") positionTemplatesFlyoutWindow();
      else positionClipboardFlyoutWindow();
      fw.webContents.send("clipboard-compact:flyout-sized");
    } catch (_) {
      // ignore
    }
  });

  ipcMain.on("ui:paste", async (_evt, { text }) => {
    await pasteText(text);
  });

  ipcMain.handle("templates:save", (_evt, { id, group, name, text }) => {
    const normalizedGroup = (group || "").trim() || "General";
    const normalizedName = (name || "").trim();
    const normalizedText = normalizeText(text || "");
    if (!normalizedName || !normalizedText) return { ok: false, error: "Name and text are required." };

    const settings = getSettings();
    const templates = getTemplates();
    const now = Date.now();

    if (id) {
      const byId = templates.find((t) => t.id === id);
      if (byId) {
        byId.group = normalizedGroup;
        byId.name = normalizedName;
        byId.text = normalizedText;
        byId.updatedAt = now;
        setTemplates(enforceSavedClipLimits(templates, settings));
        return { ok: true, id: byId.id };
      }
    }

    const existingExact = templates.find((t) => t.group === normalizedGroup && t.name === normalizedName);

    if (existingExact) {
      existingExact.text = normalizedText;
      existingExact.updatedAt = now;
    } else {
      const existingGroups = new Set(templates.map((t) => (t.group || "").trim() || "General"));
      const isNewGroup = !existingGroups.has(normalizedGroup);
      if (isNewGroup && existingGroups.size >= settings.savedGroupsMax) {
        return { ok: false, error: `Max SavedClip groups reached (${settings.savedGroupsMax}).` };
      }

      templates.unshift({
        id: cryptoRandomId(),
        group: normalizedGroup,
        name: normalizedName,
        text: normalizedText,
        createdAt: now,
        updatedAt: now,
      });
    }
    setTemplates(enforceSavedClipLimits(templates, settings));
    return { ok: true, id: existingExact?.id || templates[0]?.id };
  });

  ipcMain.handle("templates:delete", (_evt, { id }) => {
    const templates = getTemplates();
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    return { ok: true };
  });

  ipcMain.handle("templates:getAll", () => getTemplates());

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_evt, partial) => setSettings(partial || {}));

  ipcMain.handle("clipboard:getHistory", () => getClipboardHistory());

  ipcMain.handle("todos:getAll", () => getTodos());

  ipcMain.handle("todos:add", (_evt, { text, targetDate }) => {
    const normalized = normalizeTodoText(text || "");
    if (!normalized) return { ok: false, error: "Task text is required." };
    const todos = getTodos();
    todos.unshift({
      id: cryptoRandomId(),
      text: normalized,
      done: false,
      createdAt: Date.now(),
      targetDate: normalizeTargetDateYmd(targetDate),
    });
    setTodos(todos);
    return { ok: true, todos: getTodos() };
  });

  ipcMain.handle("todos:setDate", (_evt, { id, targetDate }) => {
    const todos = getTodos();
    const t = todos.find((x) => x.id === id);
    if (!t) return { ok: false, todos: getTodos() };
    t.targetDate = normalizeTargetDateYmd(targetDate);
    setTodos(todos);
    return { ok: true, todos: getTodos() };
  });

  ipcMain.handle("todos:toggle", (_evt, { id }) => {
    const todos = getTodos();
    const t = todos.find((x) => x.id === id);
    if (!t) return { ok: false, todos: getTodos() };
    t.done = !t.done;
    setTodos(todos);
    return { ok: true, todos: getTodos() };
  });

  ipcMain.handle("todos:delete", (_evt, { id }) => {
    const todos = getTodos().filter((x) => x.id !== id);
    setTodos(todos);
    return { ok: true, todos: getTodos() };
  });

  ipcMain.handle("todos:clearDone", () => {
    const todos = getTodos().filter((x) => !x.done);
    setTodos(todos);
    return { ok: true, todos: getTodos() };
  });
}

app.whenReady().then(() => {
  (async () => {
    await initStore();
    setupClipboardListener();
    bindIpc();
    setupPanelBlurDismiss();
    setupStartupLauncher();

    try {
      nativeTheme.on("updated", () => {
        sendThemeToPanel();
        applyPanelChromeTheme();
      });
    } catch (_) {
      // ignore
    }

    const win = createPanelWindow();
    // Default: keep UI hidden; hotkeys will bring it up.
    // Dev/testing override: CLIPNINJA_SHOW_ON_START=1
    win.hide();
    if (String(process.env.CLIPNINJA_SHOW_ON_START || "") === "1") {
      win.show();
      win.focus();
    }

    setupGlobalShortcuts();
    setDockIcon();
    setupTray();
    setupOpenTodosTodayOnLoginWatchers();
    scheduleOpenTodosTodayOnLogin("launch");

    if (process.platform === "darwin") {
      tickMacFrontmostPoll();
      frontmostPollInterval = setInterval(tickMacFrontmostPoll, 1500);
      logDevMacPastePermissionHints();
    }
  })();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (frontmostPollInterval) {
    clearInterval(frontmostPollInterval);
    frontmostPollInterval = null;
  }
});

// Tray app: do not auto-show the panel on app.activate — app.show() after paste would reopen the UI.

function setupTray() {
  if (tray) return;

  const base = loadTrayIconBase();
  if (!base) {
    console.error("Tray icon empty (png+svg). Check assets/icon.png existence.");
    return;
  }

  const icon = buildTrayImageWithBadges(false, false);
  tray = new Tray(icon || base.resize({ width: getTrayIconPixelSize(), height: getTrayIconPixelSize() }));
  refreshTrayIcon();

  tray.setContextMenu(buildTrayMenu());

  // Left click to open the menu near the cursor.
  tray.on("click", () => {
    const { x, y } = require("electron").screen.getCursorScreenPoint();
    const menu = buildTrayMenu();
    tray.popUpContextMenu(menu, { x, y });
  });
}