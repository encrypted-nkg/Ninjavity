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
  systemPreferences,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const AutoLaunch = require("auto-launch");

const { groupName, groupTemplatesStable, limitTemplates, reorderTemplates } = require("./template-order");

const { createLifecycleLog, errorMetadata } = require("./lifecycle-log");
let lifecycleLog = () => {};
try {
  lifecycleLog = createLifecycleLog(path.join(app.getPath("logs"), "lifecycle.log"));
} catch (_) { /* Logging is best-effort, including before app readiness. */ }
let quitReason = "external-or-system-request";
function quitApp(reason) {
  quitReason = reason;
  lifecycleLog("quit-requested", { reason });
  app.quit();
}
lifecycleLog("started", { version: app.getVersion?.() });
// Observe fatal errors without suppressing Electron/Node's normal error handling.
process.on?.("uncaughtExceptionMonitor", error => lifecycleLog("uncaught-exception", errorMetadata(error)));
process.on?.("exit", code => lifecycleLog("process-exit", { code, reason: quitReason }));
app.on("before-quit", () => lifecycleLog("before-quit", { reason: quitReason }));
app.on("child-process-gone", (_event, details) => lifecycleLog("child-process-gone", {
  type: details.type, reason: details.reason, exitCode: details.exitCode,
}));

// This is a menu-bar app: replacing or recovering its last popup must not quit
// the process. Explicit Quit / Cmd+Q and system shutdown still work normally.
app.on("window-all-closed", () => lifecycleLog("all-windows-closed-kept-alive"));

const APP_NAME = "ClipNinja";
// Stable across builds so macOS can restore the user's menu-bar placement.
const TRAY_GUID = "65db66af-6d43-4a52-b8dd-9cd0619d9080";

/**
 * A second copy (login item + manual launch, or a stale process after a crash) fights the first one
 * for the global shortcuts, so only the first instance is allowed to run.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  quitApp("duplicate-instance");
}

/**
 * Long-running menu-bar app: Chromium throttles timers and stops producing frames for hidden or
 * occluded windows, which after days of uptime leaves the overlay alive but never repainted.
 */
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
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
const CLIPBOARD_COMPACT_MAIN_WIDTH = 208;
/** Secondary window (clipboard clips + SavedClip items); shared width for both. */
const CLIPBOARD_COMPACT_FLYOUT_WIDTH = 320;
/** Until renderer reports measured height */
const CLIPBOARD_COMPACT_MIN_HEIGHT = 96;
const CLIPBOARD_COMPACT_MAX_HEIGHT = 560;
/** Used when the renderer never reports its measured height (see startCompactSizingWatchdog). */
const COMPACT_FALLBACK_HEIGHT = 320;
const COMPACT_SIZING_TIMEOUT_MS = 500;
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

/** CLIPNINJA_DEBUG=1 traces panel show/dismiss decisions — the only way to diagnose the
 *  "it went weird after a few days" class of bug without reproducing the wait. */
const DEBUG = String(process.env.CLIPNINJA_DEBUG || "") === "1";

function debugLog(...args) {
  if (DEBUG) console.log("[ClipNinja]", ...args);
}

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

// NOTE: only keys that are meaningless on their own are grabbed globally. A plain letter (we used to
// register "E") is swallowed system-wide for as long as the overlay is up, so it is handled in the
// renderer instead, where it only fires when the panel really has focus.
const OVERLAY_NAV_ACCELS = ["Up", "Down", "Left", "Right", "Escape", "Enter", "Return"];

function sendOverlayNavKey(key) {
  if (!overlayNavEnabled || !overlayNavRegistered) return;
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) {
    disableOverlayNavShortcuts();
    return;
  }
  if (currentMode !== "clipboard" && currentMode !== "templates") return;
  const k = String(key || "");
  notePanelInteraction();
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
let panelSession = 0;
let panelCompact = false;
let panelCreatedAt = 0;
let panelAnchor = null;
const MAX_IDLE_WINDOW_AGE_MS = 6 * 60 * 60 * 1000;
const { createWindowDelivery, clampToWorkArea } = require("./panel-lifecycle");
const windowDelivery = createWindowDelivery();

function retirePanelWindows(reason) {
  lifecycleLog("retire-popup-windows", { reason });
  hideAllPanels(reason);
  for (const win of [panelWindow, clipboardFlyoutWindow, templatesFlyoutWindow]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function watchRenderer(win) {
  const recover = () => {
    if (win.isDestroyed()) return;
    // Release global navigation immediately; rebuild lazily on the next shortcut.
    // Do not loop on a renderer that repeatedly crashes at startup.
    retirePanelWindows("renderer-failed");
  };
  win.webContents.on("render-process-gone", (_event, details) => {
    lifecycleLog("renderer-process-gone", { reason: details.reason, exitCode: details.exitCode });
    recover();
  });
  win.on("unresponsive", () => {
    lifecycleLog("renderer-unresponsive");
    recover();
  });
}

/** macOS: unix PID of the app that was frontmost when a global shortcut opened the panel (for paste target). */
let lastFrontmostPid = null;
let pendingPasteTarget = null;

/**
 * macOS: last foreign frontmost PID (polled), used if a shortcut lookup times out.
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
      timeout: 1500,
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

let frontmostPollBusy = false;
function tickMacFrontmostPoll() {
  if (process.platform !== "darwin" || frontmostPollBusy) return;
  frontmostPollBusy = true;
  // A slow System Events service must not block window painting or shortcut handling.
  execFile("osascript", ["-e", 'tell application "System Events" to get unix id of first process whose frontmost is true'],
    { encoding: "utf8", timeout: 1200 }, (error, stdout) => {
      frontmostPollBusy = false;
      if (error) return;
      const pid = parseInt(String(stdout).trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid) lastSeenForeignFrontmostPid = pid;
    });
}

function captureFrontmostPid() {
  if (process.platform !== "darwin") return;
  const session = panelSession;
  const fallback = lastSeenForeignFrontmostPid;
  lastFrontmostPid = fallback;
  // Shortcut panels show inactive, so the target stays frontmost while this runs.
  // Never block Electron's UI thread on System Events (which can stall after wake).
  const request = new Promise(resolve => {
    execFile("osascript", ["-e", 'tell application "System Events" to get unix id of first process whose frontmost is true'],
      { encoding: "utf8", timeout: 1200 }, (error, stdout) => {
        const pid = error ? NaN : Number(String(stdout).trim());
        resolve(Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : fallback);
      });
  });
  pendingPasteTarget = request;
  request.then(pid => {
    // A late result must not change the destination of a newer popup/editor.
    if (session !== panelSession || pendingPasteTarget !== request) return;
    pendingPasteTarget = null;
    lastFrontmostPid = pid;
    if (pid) lastSeenForeignFrontmostPid = pid;
    if (panelWatchState) panelWatchState.ownerPid = pid;
  });
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
  // Inside a packaged .app the bundle is read-only, so there is nothing to generate.
  if (app.isPackaged || !fs.existsSync(svgPath)) return pngPath;

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

/** Native template assets stay sharp and adapt to light/dark menu bars. */
function loadTrayIconBase() {
  if (trayIconBase && !trayIconBase.isEmpty()) return trayIconBase;
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", "trayTemplate.png"));
  if (icon.isEmpty()) return null;
  icon.setTemplateImage(true);
  trayIconBase = icon;
  return icon;
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

function buildTrayImageWithBadges(hasTodayRemaining, hasPastRemaining) {
  if (!hasTodayRemaining && !hasPastRemaining) return loadTrayIconBase();
  const state = hasTodayRemaining && hasPastRemaining ? "both" : hasTodayRemaining ? "today" : "overdue";
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", `tray-${state}Template.png`));
  if (icon.isEmpty()) return loadTrayIconBase();
  icon.setTemplateImage(true);
  return icon;
}

function refreshTrayIcon() {
  if (!tray) return;
  try {
    const { hasTodayRemaining, hasPastRemaining } = getTodoTrayBadgeState();
    const icon = buildTrayImageWithBadges(hasTodayRemaining, hasPastRemaining);
    if (icon && !icon.isEmpty()) tray.setImage(icon);

    let tip = APP_NAME;
    if (hasTodayRemaining) tip += " — tasks due today";
    if (hasPastRemaining) tip += " — overdue tasks";
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
      click: () => quitApp("tray-menu"),
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
    if (!fs.existsSync(svgPath)) return;
    const svgImg = createNativeImageFromSvg(fs.readFileSync(svgPath, "utf8"));
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
  return getEffectiveTheme() === "light" ? "#eef1f8" : "#080b13";
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
  return limitTemplates(templates, settings);
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
  return groupTemplatesStable(store.get("templates", [])).flatMap(g => g.items);
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
  return groupTemplatesStable(templates);
}

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) return panelWindow;

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
      // The panel spends most of its life hidden; without this Chromium freezes its timers and
      // rAF callbacks, so the layout/measure pass that sizes the overlay never runs.
      backgroundThrottling: false,
    },
  });

  const win = panelWindow;
  panelCreatedAt = Date.now();
  reassertMacWindowLevel(win);
  windowDelivery.attach(win);
  watchRenderer(win);
  win.webContents.on("did-finish-load", sendThemeToPanel);
  win.on("closed", () => {
    if (panelWindow === win) panelWindow = null;
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  panelWindow.on("blur", () => {
    onPanelOrFlyoutBlur();
  });

  panelWindow.on("hide", () => {
    stopPanelDismissWatch();
    disableOverlayNavShortcuts();
  });

  return panelWindow;
}

function hideClipboardFlyoutWindow() {
  windowDelivery.cancel(clipboardFlyoutWindow);
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
  windowDelivery.cancel(templatesFlyoutWindow);
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
  if (isSettingsPanelSticky() || panelWatchState?.pinned) return;

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
  stopPanelDismissWatch();
  disableOverlayNavShortcuts();
  debugLog("hidePanelAndFlyoutsIfNoFocus: dismissed on blur");
}

function scheduleHidePanelIfLostFocus() {
  if (isSettingsPanelSticky() || panelWatchState?.pinned) return;
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

/** Handle an explicit macOS Hide command; ordinary paste only hides our windows. */
function macUnhideApp() {
  if (process.platform === "darwin" && app.isHidden()) app.show();
}

/** Re-apply float level + all-Spaces behaviour; both can be lost across sleep / display changes. */
function reassertMacWindowLevel(win) {
  if (process.platform !== "darwin" || !win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // Packaged ClipNinja is LSUIElement; dev Electron needs the initial conversion.
      skipTransformProcessType: app.isPackaged,
    });
  } catch (_) {
    try {
      win.setAlwaysOnTop(true);
    } catch (_) {
      // ignore
    }
  }
}

/* ------------------------------------------------------------------ *
 * Dismiss watchdog
 *
 * The shortcut overlay is shown with showInactive() so the app you were typing
 * in stays frontmost. That window never becomes key, so it never emits "blur"
 * and the blur-based dismissal above can never run — clicking elsewhere left
 * the panel on screen indefinitely (and, with it, the global arrow/Enter grab).
 * This poll is the safety net: it dismisses on app switch, on the pointer
 * leaving the panel, and on plain inactivity.
 * ------------------------------------------------------------------ */

const PANEL_WATCH_INTERVAL_MS = 250;
/** Ignore everything right after opening so the panel cannot dismiss itself instantly. */
const PANEL_WATCH_GRACE_MS = 700;
/** Pointer must be this far outside the panel before the "moved away" timer starts. */
const PANEL_CURSOR_MARGIN_PX = 48;
/** How long a focus-seeking panel gets to actually become key before we stop trusting "blur". */
const PANEL_FOCUS_GRACE_MS = 2500;
const PANEL_UNFOCUSED_CURSOR_AWAY_MS = 4000;

/**
 * Two idle budgets per panel:
 *   idleMs          — the panel has held focus at some point, so "click elsewhere" reaches us as a
 *                     blur and the timer is only a long backstop.
 *   unfocusedIdleMs — the panel was shown inactive and never became key. macOS gives us no way to
 *                     see a click that lands in another app, so an untouched overlay has to time
 *                     itself out; this is deliberately short.
 */
const PANEL_WATCH_PROFILES = {
  clipboard: { cursorAwayMs: 1200, unfocusedIdleMs: 8000, idleMs: 30000 },
  templates: { cursorAwayMs: 1200, unfocusedIdleMs: 8000, idleMs: 30000 },
  // Typing panels: the pointer is irrelevant while they have focus.
  todoQuickAdd: { cursorAwayMs: 0, unfocusedIdleMs: 8000, idleMs: 60000 },
  todosToday: { cursorAwayMs: 0, unfocusedIdleMs: 15000, idleMs: 120000 },
  todos: { cursorAwayMs: 0, unfocusedIdleMs: 30000, idleMs: 300000 },
  info: { cursorAwayMs: 0, unfocusedIdleMs: 30000, idleMs: 300000 },
};

let panelWatchTimer = null;
let panelWatchState = null;

function anyPanelWindowVisible() {
  const vis = (w) => !!w && !w.isDestroyed() && w.isVisible();
  return vis(panelWindow) || vis(clipboardFlyoutWindow) || vis(templatesFlyoutWindow);
}

/** Union of the visible panel + flyout rectangles, or null when nothing is on screen. */
function visiblePanelUnionBounds() {
  let union = null;
  for (const w of [panelWindow, clipboardFlyoutWindow, templatesFlyoutWindow]) {
    if (!w || w.isDestroyed() || !w.isVisible()) continue;
    const b = w.getBounds();
    if (!union) {
      union = { ...b };
      continue;
    }
    const right = Math.max(union.x + union.width, b.x + b.width);
    const bottom = Math.max(union.y + union.height, b.y + b.height);
    union.x = Math.min(union.x, b.x);
    union.y = Math.min(union.y, b.y);
    union.width = right - union.x;
    union.height = bottom - union.y;
  }
  return union;
}

function pointInBounds(point, bounds, margin) {
  return (
    point.x >= bounds.x - margin &&
    point.x <= bounds.x + bounds.width + margin &&
    point.y >= bounds.y - margin &&
    point.y <= bounds.y + bounds.height + margin
  );
}

/** Any keystroke / pointer activity in the panel postpones every automatic dismissal. */
function notePanelInteraction() {
  if (!panelWatchState) return;
  panelWatchState.lastInteractionAt = Date.now();
  panelWatchState.cursorAwaySince = 0;
}

/**
 * Pinned while the renderer has an editor open: no timer may close the panel out from under
 * someone who is halfway through typing a snippet.
 */
function setPanelAutoDismissEnabled(enabled) {
  if (!panelWatchState) return;
  panelWatchState.pinned = !enabled;
  if (!enabled) cancelPendingPanelBlurDismiss();
  if (enabled) notePanelInteraction();
  debugLog("auto-dismiss", enabled ? "enabled" : "pinned open");
}

function hideAllPanels(reason = "explicit") {
  debugLog("hideAllPanels:", reason);
  panelSession += 1;
  pendingPasteTarget = null;
  panelCompact = false;
  windowDelivery.cancel(panelWindow);
  clearTimeout(compactSizingWatchdogTimer);
  clearTimeout(flyoutSizingWatchdogTimer);
  cancelPendingPanelBlurDismiss();
  stopPanelDismissWatch();
  hideClipboardFlyoutWindow();
  hideTemplatesFlyoutWindow();
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    try {
      panelWindow.hide();
    } catch (_) {
      // ignore
    }
  }
  overlayNavEnabled = false;
  disableOverlayNavShortcuts();
}

function stopPanelDismissWatch() {
  if (panelWatchTimer) {
    clearInterval(panelWatchTimer);
    panelWatchTimer = null;
  }
  panelWatchState = null;
}

function startPanelDismissWatch(mode) {
  stopPanelDismissWatch();
  // Settings is deliberately sticky: it stays up until the user closes it.
  if (mode === "settings") return;
  const profile = PANEL_WATCH_PROFILES[mode];
  if (!profile) return;

  const now = Date.now();
  panelWatchState = {
    mode,
    openedAt: now,
    lastInteractionAt: now,
    cursorAwaySince: 0,
    everFocused: false,
    pinned: false,
    lastCursorPoint: null,
    ownerPid: lastSeenForeignFrontmostPid,
    ...profile,
  };
  panelWatchTimer = setInterval(panelDismissTick, PANEL_WATCH_INTERVAL_MS);
}

function panelDismissTick() {
  // Nothing on screen: make sure the global arrow/Enter grab is not left behind.
  if (!anyPanelWindowVisible()) {
    stopPanelDismissWatch();
    disableOverlayNavShortcuts();
    return;
  }
  if (isSettingsPanelSticky()) return;

  const st = panelWatchState;
  if (!st || st.pinned) return;
  const now = Date.now();
  if (now - st.openedAt < PANEL_WATCH_GRACE_MS) return;

  // While one of our windows holds focus the normal blur path is in charge.
  const focused = BrowserWindow.getFocusedWindow();
  if (isOurPanelOrFlyoutWindow(focused)) {
    st.everFocused = true;
    st.lastInteractionAt = now;
    st.cursorAwaySince = 0;
    return;
  }

  // A panel that asked for focus but never got it (typically the post-login todo panel, opened
  // while macOS is still settling) can never emit "blur", so fall back to pointer-away dismissal.
  if (st.cursorAwayMs === 0 && !st.everFocused && now - st.openedAt > PANEL_FOCUS_GRACE_MS) {
    st.cursorAwayMs = PANEL_UNFOCUSED_CURSOR_AWAY_MS;
  }

  // The user moved to another app (click, Cmd+Tab, Spaces).
  if (!pendingPasteTarget && st.ownerPid && lastSeenForeignFrontmostPid && lastSeenForeignFrontmostPid !== st.ownerPid) {
    hideAllPanels("frontmost-app-changed");
    return;
  }

  let point = null;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    point = null;
  }

  if (point) {
    const union = visiblePanelUnionBounds();
    const inside = !union || pointInBounds(point, union, PANEL_CURSOR_MARGIN_PX);
    // The overlay opens under the pointer, so "pointer is inside" is the starting state and must
    // not by itself count as activity — otherwise opening it and walking away never times out.
    // Only actual movement does.
    const moved =
      !!st.lastCursorPoint && (st.lastCursorPoint.x !== point.x || st.lastCursorPoint.y !== point.y);
    st.lastCursorPoint = point;

    if (inside) {
      st.cursorAwaySince = 0;
      if (moved) st.lastInteractionAt = now;
    } else if (st.cursorAwayMs > 0) {
      if (!st.cursorAwaySince) {
        st.cursorAwaySince = now;
      } else if (now - st.cursorAwaySince >= st.cursorAwayMs) {
        hideAllPanels("pointer-left-panel");
        return;
      }
    }
  }

  const idleBudget = st.everFocused ? st.idleMs : st.unfocusedIdleMs;
  if (idleBudget > 0 && now - st.lastInteractionAt >= idleBudget) {
    hideAllPanels(st.everFocused ? "idle" : "untouched-overlay-timeout");
  }
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
  const display = screen.getDisplayMatching(b);
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
  const display = screen.getDisplayMatching(b);
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
      // The panel spends most of its life hidden; without this Chromium freezes its timers and
      // rAF callbacks, so the layout/measure pass that sizes the overlay never runs.
      backgroundThrottling: false,
    },
  });

  const win = clipboardFlyoutWindow;
  reassertMacWindowLevel(win);
  windowDelivery.attach(win);
  watchRenderer(win);
  win.webContents.on("did-finish-load", sendThemeToPanel);
  win.on("closed", () => {
    if (clipboardFlyoutWindow === win) clipboardFlyoutWindow = null;
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "clipboard-flyout.html"));

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
      // The panel spends most of its life hidden; without this Chromium freezes its timers and
      // rAF callbacks, so the layout/measure pass that sizes the overlay never runs.
      backgroundThrottling: false,
    },
  });

  const win = templatesFlyoutWindow;
  reassertMacWindowLevel(win);
  windowDelivery.attach(win);
  watchRenderer(win);
  win.webContents.on("did-finish-load", sendThemeToPanel);
  win.on("closed", () => {
    if (templatesFlyoutWindow === win) templatesFlyoutWindow = null;
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "templates-flyout.html"));

  templatesFlyoutWindow.on("blur", () => {
    onPanelOrFlyoutBlur();
  });

  return templatesFlyoutWindow;
}

function positionPanelNearCursor() {
  if (!panelWindow) return;
  const { width, height } = panelWindow.getBounds();
  const point = panelAnchor || screen.getCursorScreenPoint();
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
  if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible() &&
      Date.now() - panelCreatedAt > MAX_IDLE_WINDOW_AGE_MS) {
    retirePanelWindows("refresh-aged-native-windows");
  }
  const session = ++panelSession;
  pendingPasteTarget = null;
  panelCompact = !!opts.compact && (mode === "clipboard" || mode === "templates");
  panelAnchor = opts.fromShortcut ? screen.getCursorScreenPoint() : null;
  currentMode = mode;
  cancelPendingPanelBlurDismiss();
  // Only an explicit macOS Hide command needs app-level unhiding.
  macUnhideApp();
  const win = createPanelWindow();
  const compact = !!opts.compact;
  const fromShortcut = !!opts.fromShortcut;
  // Start loading the right pane alongside the main pane, including after recovery.
  // Startup normally preloads both, so browsing a group never starts a renderer.
  if (panelCompact) {
    if (mode === "clipboard") createClipboardFlyoutWindow();
    else createTemplatesFlyoutWindow();
  }

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
  ensurePanelOnScreen();
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
  windowDelivery.send(win, "ui:update", message);

  // Float level and the all-Spaces collection behaviour can be dropped across sleep and display
  // changes; re-apply on every open so the panel cannot reappear on a Space you are not looking at.
  reassertMacWindowLevel(win);

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
  } else {
    try {
      win.moveTop();
    } catch (_) {
      // ignore
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
    // app captured in captureFrontmostPid() when the shortcut opened this window.
    win.focus();
    try {
      win.webContents.focus();
    } catch (_) {
      // ignore
    }
    if (process.platform === "darwin" && typeof app.focus === "function") {
      app.focus({ steal: true });
    }
    // Right after login/unlock macOS often refuses the first activation, and an unfocused panel
    // never emits "blur" — so it could never be dismissed by clicking away. Retry a few times.
    retryPanelFocus(win, 3, session);
  }
  win.webContents.invalidate();
  enableOverlayNavShortcuts();
  startCompactSizingWatchdog(mode, compact || fromShortcut);
  startPanelDismissWatch(mode);
  debugLog("panel shown:", mode, { fromShortcut, compact, bounds: win.getBounds(), focused: win.isFocused() });
}

function retryPanelFocus(win, attemptsLeft, session) {
  if (attemptsLeft <= 0) return;
  setTimeout(() => {
    if (session !== panelSession || overlayNavEnabled) return;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (win.isFocused()) return;
    try {
      win.focus();
      if (process.platform === "darwin" && typeof app.focus === "function") {
        app.focus({ steal: true });
      }
    } catch (_) {
      // ignore
    }
    retryPanelFocus(win, attemptsLeft - 1, session);
  }, 400);
}

/**
 * Compact overlays are sized by the renderer: it measures its content and reports a height back.
 * If that round-trip never lands (a throttled or wedged renderer), the window is stuck at the 96px
 * minimum with clipped content — the "messed up UI". Unlock it from here after a short wait.
 */
let compactSizingWatchdogTimer = null;
let compactSizingReported = false;

function noteCompactSizingReported() {
  compactSizingReported = true;
  if (compactSizingWatchdogTimer) {
    clearTimeout(compactSizingWatchdogTimer);
    compactSizingWatchdogTimer = null;
  }
}

function startCompactSizingWatchdog(mode, compact) {
  if (compactSizingWatchdogTimer) {
    clearTimeout(compactSizingWatchdogTimer);
    compactSizingWatchdogTimer = null;
  }
  if (!compact || (mode !== "clipboard" && mode !== "templates")) return;
  compactSizingReported = false;
  compactSizingWatchdogTimer = setTimeout(() => {
    compactSizingWatchdogTimer = null;
    if (compactSizingReported) return;
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return;
    debugLog("compact sizing watchdog fired — renderer never reported a height");
    try {
      panelWindow.setSize(CLIPBOARD_COMPACT_MAIN_WIDTH, COMPACT_FALLBACK_HEIGHT);
      ensurePanelOnScreen();
      panelWindow.webContents.send("clipboard-compact:main-sized");
    } catch (_) {
      // ignore
    }
  }, COMPACT_SIZING_TIMEOUT_MS);
}

/** Displays come and go (dock / undock); never leave the panel on coordinates nothing shows. */
function ensurePanelOnScreen() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  try {
    const b = panelWindow.getBounds();
    const next = clampToWorkArea(b, screen.getDisplayMatching(b).workArea);
    panelWindow.setBounds(next);

  } catch (_) {
    // ignore
  }
}

function openTemplatesEditor(templateId) {
  hideAllPanels("open-editor");
  currentMode = "templates";
  overlayNavEnabled = false;
  stopPanelDismissWatch();
  macUnhideApp();
  disableOverlayNavShortcuts();
  hideClipboardFlyoutWindow();
  hideTemplatesFlyoutWindow();

  const win = createPanelWindow();
  win.setSize(480, 680);
  positionPanelWindow({ fromShortcut: false });
  ensurePanelOnScreen();

  const payload = buildModePayload("templates");
  const message = {
    mode: "templates",
    ...payload,
    compact: false,
    pasteOnClick: false,
    editTemplateId: templateId || null,
  };
  windowDelivery.send(win, "ui:update", message);

  reassertMacWindowLevel(win);
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
    const templates = getTemplates();
    return {
      templatesGrouped: groupTemplates(templates),
      templatesFlat: flattenTemplatesForUI(templates),
      templatesAll: templates,
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
  return groupTemplatesStable(templates).flatMap(g => g.items);
}

async function pasteText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return;

  // Snapshot before hide invalidates the session. A fast Enter still uses the
  // lookup belonging to this popup, even if another shortcut opens meanwhile.
  const target = pendingPasteTarget || Promise.resolve(lastFrontmostPid);
  hideAllPanels("paste");

  const pid = await target;
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

  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
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

/**
 * Sleep / lock / display changes are where this app used to drift out of shape: panels survive as
 * invisible-but-live windows and the global arrow+Enter grab survives with them. Tear the UI down
 * on the way out and rebuild the OS-level state on the way back in.
 */
function setupSystemStateWatchers() {
  const teardown = () => {
    if (openTodosTodayOnLoginTimer) {
      clearTimeout(openTodosTodayOnLoginTimer);
      openTodosTodayOnLoginTimer = null;
    }
    hideAllPanels("system-suspend-or-lock");
  };

  const restore = () => {
    // Restore native window flags without activating the app after sleep.
    ensureGlobalShortcutsRegistered(false);
    for (const w of [panelWindow, clipboardFlyoutWindow, templatesFlyoutWindow]) {
      reassertMacWindowLevel(w);
    }
    trayIconBase = null;
    refreshTrayMenuIfReady();
  };

  try {
    powerMonitor.on("suspend", teardown);
    powerMonitor.on("lock-screen", teardown);
    powerMonitor.on("resume", restore);
    powerMonitor.on("unlock-screen", restore);
  } catch (_) {
    // ignore
  }

  // A panel positioned on a display that has just been unplugged is invisible but still live.
  for (const evt of ["display-added", "display-removed", "display-metrics-changed"]) {
    try {
      screen.on(evt, () => hideAllPanels("display-change"));
    } catch (_) {
      // ignore
    }
  }
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

/**
 * Toggle instead of re-show: pressing the same shortcut while its panel is up closes it. Without
 * this a panel that failed to draw could only be dismissed by pasting.
 */
function togglePanel(mode, opts) {
  const alreadyOpen =
    currentMode === mode && panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible();
  if (alreadyOpen) {
    hideAllPanels("shortcut-toggle");
    return;
  }
  ensurePanelVisible(mode, opts);
}

const GLOBAL_SHORTCUTS = [
  {
    accelerator: "Command+Shift+V",
    label: "Cmd+Shift+V (clipboard)",
    run: () => {
      togglePanel("clipboard", { fromShortcut: true, compact: true });
      if (panelCompact) captureFrontmostPid();
    },
  },
  {
    accelerator: "Command+Shift+B",
    label: "Cmd+Shift+B (SavedClip)",
    run: () => {
      togglePanel("templates", { fromShortcut: true, compact: true });
      if (panelCompact) captureFrontmostPid();
    },
  },
  {
    accelerator: "Command+Shift+D",
    label: "Cmd+Shift+D (quick add todo)",
    run: () => togglePanel("todoQuickAdd", { fromShortcut: true, compact: true }),
  },
  {
    accelerator: "Alt+Shift+D",
    label: "Opt+Shift+D (today's todos)",
    run: () => togglePanel("todosToday", { fromShortcut: true, compact: true }),
  },
];

let globalShortcutHealthTimer = null;

/**
 * macOS silently drops global shortcut registrations across long sleeps and fast user switching.
 * Re-register anything that went missing instead of waiting for a restart.
 */
function ensureGlobalShortcutsRegistered(logMissing = false) {
  for (const sc of GLOBAL_SHORTCUTS) {
    let registered = false;
    try {
      registered = globalShortcut.isRegistered(sc.accelerator);
    } catch (_) {
      registered = false;
    }
    if (registered) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(sc.accelerator, sc.run);
    } catch (_) {
      ok = false;
    }
    if (ok) {
      if (logMissing) console.log(`Shortcut (re)registered: ${sc.label}`);
    } else {
      console.warn(`Failed to register ${sc.label} (may be taken by another app or blocked by macOS).`);
    }
  }
}

function setupGlobalShortcuts() {
  ensureGlobalShortcutsRegistered(true);
  if (globalShortcutHealthTimer) clearInterval(globalShortcutHealthTimer);
  globalShortcutHealthTimer = setInterval(() => ensureGlobalShortcutsRegistered(false), 60000);
}

/** macOS registers login items through LaunchServices; Electron exposes that directly. */
function useNativeLoginItem() {
  return process.platform === "darwin";
}

function isLoginItemEnabled() {
  if (useNativeLoginItem()) {
    try {
      return !!app.getLoginItemSettings().openAtLogin;
    } catch (_) {
      return false;
    }
  }
  return startupLauncher ? startupLauncher.isEnabled() : Promise.resolve(false);
}

async function setLoginItemEnabled(enabled) {
  if (useNativeLoginItem()) {
    // openAsHidden keeps the menu-bar app from flashing a window during login.
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    return;
  }
  if (!startupLauncher) return;
  if (enabled) await startupLauncher.enable();
  else await startupLauncher.disable();
}

function setupStartupLauncher() {
  if (!useNativeLoginItem()) {
    startupLauncher = new AutoLaunch({
      name: APP_NAME,
      // Works in dev and in packaged apps.
      path: process.execPath,
    });
  }

  const desired = store.get("startupEnabled", false);
  Promise.resolve(isLoginItemEnabled())
    .then((enabled) => (enabled === desired ? null : setLoginItemEnabled(desired)))
    .catch(() => {});
}

/**
 * LSUIElement apps show no menu bar, but an application menu is still what gives the app its
 * standard key equivalents — without it Cmd+C/V/A/Z stop working inside our own text fields.
 */
function setupApplicationMenu() {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [{ role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { label: "Quit ClipNinja", accelerator: "CommandOrControl+Q", click: () => quitApp("application-menu") }],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
    ]),
  );
}

/** Same stuck-at-minimum guard as the main panel, for the separate items window. */
let flyoutSizingWatchdogTimer = null;
let flyoutSizingReported = false;

function noteFlyoutSizingReported() {
  flyoutSizingReported = true;
  if (flyoutSizingWatchdogTimer) {
    clearTimeout(flyoutSizingWatchdogTimer);
    flyoutSizingWatchdogTimer = null;
  }
}

function startFlyoutSizingWatchdog(fw) {
  if (flyoutSizingWatchdogTimer) clearTimeout(flyoutSizingWatchdogTimer);
  flyoutSizingReported = false;
  flyoutSizingWatchdogTimer = setTimeout(() => {
    flyoutSizingWatchdogTimer = null;
    if (flyoutSizingReported) return;
    if (!fw || fw.isDestroyed() || !fw.isVisible()) return;
    try {
      fw.setSize(CLIPBOARD_COMPACT_FLYOUT_WIDTH, COMPACT_FALLBACK_HEIGHT);
      fw.webContents.send("clipboard-compact:flyout-sized");
    } catch (_) {
      // ignore
    }
  }, COMPACT_SIZING_TIMEOUT_MS);
}

function clampClipboardCompactHeight(h) {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n)) return CLIPBOARD_COMPACT_MIN_HEIGHT;
  return Math.max(CLIPBOARD_COMPACT_MIN_HEIGHT, Math.min(CLIPBOARD_COMPACT_MAX_HEIGHT, n));
}

const flyoutContentKeys = new WeakMap();

function bindIpc() {
  ipcMain.handle("data:getStartupEnabled", () => store.get("startupEnabled", false));

  ipcMain.handle("data:setStartupEnabled", async (_evt, enabled) => {
    store.set("startupEnabled", !!enabled);
    try {
      await setLoginItemEnabled(!!enabled);
    } catch (e) {
      console.error("Failed to set startup:", e);
    }
    return enabled;
  });

  ipcMain.on("ui:close", () => {
    hideAllPanels("ui-close");
  });

  /** Renderer heartbeat: any typing / pointer activity postpones the automatic dismissal. */
  ipcMain.on("ui:interaction", () => {
    notePanelInteraction();
  });

  ipcMain.on("ui:set-auto-dismiss", (_evt, enabled) => {
    setPanelAutoDismissEnabled(enabled !== false);
  });

  ipcMain.on("ui:set-panel-mode", (_evt, { mode } = {}) => {
    if (typeof mode !== "string" || !mode) return;
    if (mode !== currentMode) {
      panelSession += 1;
      panelCompact = false;
      disableOverlayNavShortcuts();
    }
    currentMode = mode;
    if (mode === "settings") {
      cancelPendingPanelBlurDismiss();
      stopPanelDismissWatch();
    }
  });

  ipcMain.on("ui:open-templates-editor", (_evt, { id } = {}) => {
    openTemplatesEditor(id);
  });

  ipcMain.on("clipboard-flyout:sync", (_evt, payload) => {
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible() ||
        !panelCompact || currentMode !== "clipboard" || _evt.sender !== panelWindow.webContents) return;
    if (!payload || !payload.show) {
      hideClipboardFlyoutWindow();
      return;
    }
    const fw = createClipboardFlyoutWindow();
    const opening = !fw.isVisible();
    const contentKey = JSON.stringify([payload.entries || [], !!payload.pasteOnClick]);
    const contentChanged = flyoutContentKeys.get(fw) !== contentKey;
    flyoutContentKeys.set(fw, contentKey);
    if (opening) {
      positionClipboardFlyoutWindow();
      reassertMacWindowLevel(fw);
      if (typeof fw.showInactive === "function") {
        fw.showInactive();
      } else {
        fw.show();
      }
    }
    if (contentChanged) startFlyoutSizingWatchdog(fw);
    try {
      windowDelivery.send(fw, "clipboard-flyout:render", payload);
      if (opening) fw.webContents.invalidate();
    } catch (_) {
      // ignore
    }
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        if (!overlayNavEnabled) {
          panelWindow.focus();
          panelWindow.webContents.focus();
        }
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
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible() ||
        !panelCompact || currentMode !== "templates" || _evt.sender !== panelWindow.webContents) return;
    if (!payload || !payload.show) {
      hideTemplatesFlyoutWindow();
      return;
    }
    const fw = createTemplatesFlyoutWindow();
    const opening = !fw.isVisible();
    const contentKey = JSON.stringify([payload.entries || [], !!payload.pasteOnClick]);
    const contentChanged = flyoutContentKeys.get(fw) !== contentKey;
    flyoutContentKeys.set(fw, contentKey);
    if (opening) {
      positionTemplatesFlyoutWindow();
      reassertMacWindowLevel(fw);
      if (typeof fw.showInactive === "function") {
        fw.showInactive();
      } else {
        fw.show();
      }
    }
    if (contentChanged) startFlyoutSizingWatchdog(fw);
    try {
      windowDelivery.send(fw, "templates-flyout:render", payload);
      if (opening) fw.webContents.invalidate();
    } catch (_) {
      // ignore
    }
    if (panelWindow && !panelWindow.isDestroyed()) {
      try {
        if (!overlayNavEnabled) {
          panelWindow.focus();
          panelWindow.webContents.focus();
        }
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
    if (!panelCompact || !panelWindow || !panelWindow.isVisible() || _evt.sender !== panelWindow.webContents) return;
    noteCompactSizingReported();
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const h = clampClipboardCompactHeight(height);
    try {
      panelWindow.setSize(CLIPBOARD_COMPACT_MAIN_WIDTH, h);
      positionPanelNearCursor();
      ensurePanelOnScreen();
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
    if (!fw || fw.isDestroyed() || !fw.isVisible() || _evt.sender !== fw.webContents) return;
    noteFlyoutSizingReported();
    try {
      const bounds = fw.getBounds();
      if (bounds.width !== CLIPBOARD_COMPACT_FLYOUT_WIDTH || bounds.height !== h) {
        fw.setSize(CLIPBOARD_COMPACT_FLYOUT_WIDTH, h);
      }
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
        if (groupName(byId) !== normalizedGroup) {
          const destination = templates.filter(t => groupName(t) === normalizedGroup);
          if (destination.length >= settings.savedPerGroup) {
            return { ok: false, error: `This group is full (${settings.savedPerGroup} snippets).` };
          }
          const otherGroups = new Set(templates.filter(t => t !== byId).map(groupName));
          if (!otherGroups.has(normalizedGroup) && otherGroups.size >= settings.savedGroupsMax) {
            return { ok: false, error: `Max SavedClip groups reached (${settings.savedGroupsMax}).` };
          }
          templates.splice(templates.indexOf(byId), 1);
          templates.push(byId); // Moving groups appends without disturbing either group's order.
        }
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

      if (templates.filter(t => groupName(t) === normalizedGroup).length >= settings.savedPerGroup) {
        return { ok: false, error: `This group is full (${settings.savedPerGroup} snippets).` };
      }
      templates.push({
        id: cryptoRandomId(),
        group: normalizedGroup,
        name: normalizedName,
        text: normalizedText,
        createdAt: now,
        updatedAt: now,
      });
    }
    setTemplates(enforceSavedClipLimits(templates, settings));
    return { ok: true, id: existingExact?.id || templates[templates.length - 1]?.id };
  });

  ipcMain.handle("templates:delete", (_evt, { id }) => {
    const templates = getTemplates();
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    return { ok: true };
  });

  ipcMain.handle("templates:reorder", (_evt, move) => {
    try {
      const templates = reorderTemplates(getTemplates(), move);
      setTemplates(templates);
      if (panelWindow && !panelWindow.isDestroyed()) {
        windowDelivery.send(panelWindow, "templates:order-changed", { templates, move });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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

app.on("second-instance", () => {
  // Someone launched a second copy (login item + manual open): surface the running one instead.
  macUnhideApp();
  refreshTrayMenuIfReady();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
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
    createClipboardFlyoutWindow();
    createTemplatesFlyoutWindow();
    if (String(process.env.CLIPNINJA_SHOW_ON_START || "") === "1") {
      win.show();
      win.focus();
    }

    setupApplicationMenu();
    setupGlobalShortcuts();
    setDockIcon();
    setupTray();
    setupOpenTodosTodayOnLoginWatchers();
    setupSystemStateWatchers();
    scheduleOpenTodosTodayOnLogin("launch");

    if (process.platform === "darwin") {
      tickMacFrontmostPoll();
      frontmostPollInterval = setInterval(tickMacFrontmostPoll, 1500);
      logDevMacPastePermissionHints();
    }
    lifecycleLog("ready");
  })().catch(error => {
    lifecycleLog("startup-failed", errorMetadata(error));
    console.error("ClipNinja failed to start:", error);
    quitApp("startup-failed");
  });
});

app.on("will-quit", () => {
  lifecycleLog("will-quit", { reason: quitReason });
  globalShortcut.unregisterAll();
  if (frontmostPollInterval) {
    clearInterval(frontmostPollInterval);
    frontmostPollInterval = null;
  }
  if (globalShortcutHealthTimer) {
    clearInterval(globalShortcutHealthTimer);
    globalShortcutHealthTimer = null;
  }
  hideAllPanels("quit");
  clearInterval(clipboardPollInterval);
  clearTimeout(openTodosTodayOnLoginTimer);
});

// Tray app: do not auto-show the panel on app.activate — app.show() after paste would reopen the UI.

function setupTray() {
  if (tray) return;

  const base = loadTrayIconBase();
  if (!base) {
    console.error("Tray icon empty. Check assets/trayTemplate.png existence.");
    return;
  }

  const icon = buildTrayImageWithBadges(false, false);
  prepareTrayPosition();
  tray = new Tray(icon || base, TRAY_GUID);
  refreshTrayIcon();

  tray.setContextMenu(buildTrayMenu());

  // Left click to open the menu near the cursor.
  tray.on("click", () => {
    const { x, y } = require("electron").screen.getCursorScreenPoint();
    const menu = buildTrayMenu();
    tray.popUpContextMenu(menu, { x, y });
  });
}

function prepareTrayPosition() {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  // AppKit otherwise adds new items at the far left, potentially behind a MacBook
  // notch. Seed only an unset position; macOS saves subsequent Command-drag moves.
  // getUserDefault returns 0 for a missing numeric key (also a valid rightmost slot).
  const key = `NSStatusItem Preferred Position ${TRAY_GUID}`;
  try {
    if (systemPreferences.getUserDefault(key, "double") === 0) {
      systemPreferences.setUserDefault(key, "double", 0);
    }
  } catch (error) {
    console.error("Could not initialize menu-bar position:", error);
  }
}
