# ClipNinja (macOS, M2 compatible)

Minimal clipboard + template manager.

## Features
- Clipboard history: keeps the last 10 copied text entries.
- Templates: save “preconfigured texts” grouped by a logical group name.
- Minimal UI overlay:
  - `Cmd+Shift+V` opens clipboard history
  - `Cmd+Shift+B` opens saved snippets (add snippets from the menu-bar SavedClip view)
- Status bar (top-right) tray icon with a small native menu:
  - Clipboard, SavedClip, Settings, Quit
- Paste selected item/template:
  - Select an item in the overlay, press `Enter` (copies to clipboard + triggers `Cmd+V`)
- Start on login toggle inside the UI.
- **Today on login** (Settings, on by default): opens today’s todo list after macOS sign-in, unlock, or when the app starts at login.

## Install as a macOS app (recommended)

ClipNinja is meant to live in the menu bar as a normal macOS application, not to be started from a
terminal. One command builds the bundle and installs it:

```bash
npm run app:install
```

It builds for this Mac's own architecture. Set `UNIVERSAL=1` to build an Apple silicon + Intel
bundle instead — only needed to hand the app to someone else, and it needs several GB more free
disk space.

That produces `/Applications/ClipNinja.app` — an `LSUIElement` (menu-bar only) app with its own
bundle identity, so macOS shows the permission prompts and Privacy & Security entries as
**ClipNinja** rather than **Electron**. Add it to Login Items from the app's own Settings panel.

Grant these once, in System Settings → Privacy & Security:

- **Accessibility** → ClipNinja — required to paste into the app you were working in
- **Automation** → ClipNinja → System Events

The build is ad-hoc signed unless you supply a Developer ID (see below). Because those grants are
tied to the exact signed binary, re-running `npm run app:install` may require toggling the two
switches off and on again.

## Panel behaviour

The shortcut overlay is shown *without* activating ClipNinja, so the app you were typing in keeps
focus and the paste lands in the right place. macOS gives an inactive window no way to observe a
click that lands in another app, so dismissal works on several signals at once:

- clicking outside once the panel has focus (a normal blur)
- moving the pointer away from the panel
- switching to another app
- pressing the same shortcut again, which now toggles the panel closed
- a short timeout for an overlay that was opened and never touched

Any typing or pointer activity in the panel resets those timers, and the panel is pinned open while
a snippet editor is on screen.

## Run (dev)
1. `cd ClipNinja`
2. `npm install` (on macOS this also ad-hoc signs the local Electron runtime)
3. `npm start`

If macOS shows **“Electron.app was not opened because it contains malware”** and moves Electron to the Bin:

```bash
# Empty Bin / delete the trashed Electron.app, then:
rm -rf node_modules/electron
npm install
npm run fix:electron-mac   # if postinstall didn't run
npm start
```

Set `CLIPNINJA_DEBUG=1` to trace why a panel was shown or dismissed:

```bash
CLIPNINJA_DEBUG=1 npm start
```

Only one copy of ClipNinja runs at a time. A second launch hands off to the running instance
instead of starting a rival that would compete for the same global shortcuts.

## macOS permissions
- Hotkeys and paste keystroke injection require Accessibility/Input Monitoring permission.
- First launch may prompt you to allow controlling your computer / input monitoring.
- In dev (`npm start`) macOS sees the app as **Electron**, so the permissions must be granted to
  Electron. Installing with `npm run app:install` is what makes them apply to **ClipNinja**.

## macOS “contains malware” / Gatekeeper block (Tahoe 26+)

This is a **false positive** from Apple’s XProtect/Gatekeeper, not actual malware.

- **Dev (`npm start`):** macOS may trash `node_modules/electron/dist/Electron.app` when an Electron build’s notarization is revoked or incomplete. ClipNinja bumps Electron and runs `scripts/postinstall-electron-mac.sh` to ad-hoc sign that local runtime. You do **not** need an Apple Developer account for this.
- **Packaged `.app` / DMG:** still needs Developer ID + notarization for reliable double-click installs on macOS 26.5+.

### Packaged `.app` / DMG

If Gatekeeper blocks a DMG install, use `npm start` for daily use, or sign/notarize:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
npm run dist:signed
```

Install from the new `release/*.dmg`. A properly signed + notarized build should open normally on macOS 26+.

`npm run dist` builds a universal (Apple silicon + Intel) DMG and ZIP; `npm run app:install` builds
the same bundle and copies it straight to `/Applications`.

## Popup reliability and verification

Shortcut panels and their item flyouts stay inactive, preserving the current app and full-screen
Space. Pasting hides individual windows rather than putting the entire app into macOS's hidden
state. Pending renderer messages and focus retries are cancelled on dismissal. A failed renderer
releases navigation shortcuts immediately and is recreated on the next open. Hidden native windows
older than six hours are refreshed on the next invocation; clipboard history, snippets, and tasks
remain in the persistent store. Background frontmost-app polling is asynchronous and bounded.

Run `npm test` for the lifecycle regressions and `npm run lint` for JavaScript syntax checks.
Tests use mocked Electron windows; they do not emulate macOS WindowServer or prove long-uptime
stability. Before considering a release validated, check the installed app:

- In a full-screen editor/browser, open ⌘⇧B and ⌘⇧V, navigate into a group, and paste into a
  disposable text field. The active Space should stay unchanged.
- Open and dismiss repeatedly; arrow keys and Return must work normally in the target app afterward.
- Open Settings, dismiss it, and immediately invoke ⌘⇧B; no delayed focus jump should occur.
- Sleep, unlock, switch Spaces, and disconnect an external display; panels should remain visible
  and within the active display's work area on the next shortcut.
- Repeat after several days of normal use, and check dark/light themes, long group names, maximum
  group counts, snippet editing (including multiline text), and empty lists.

### Popup responsiveness checks

Shortcut lookups run asynchronously so slow macOS System Events responses do not block drawing.
The two item widgets preload invisibly at startup; a recovered popup starts its main and item
renderers together. Text layout reports its height immediately instead of waiting for animation
frames. Paste retains the lookup belonging to the popup that selected the item.

Run `npm test` for the slow-lookup, rapid-switching, quick-paste, recovery, and scrolling regressions.
For real Chromium layout timings, run:

```sh
npx electron tests/render-latency.cjs
```

This isolated benchmark uses synthetic snippets and hidden offscreen windows. It checks sizing
and selection visibility and reports renderer startup and IPC-to-layout times, not total on-screen
latency. It does not read or change your clipboard or saved snippets.
