# ClipNinja (macOS, M2 compatible)

Minimal clipboard + template manager.

## Features
- Clipboard history: keeps the last 10 copied text entries.
- Templates: save “preconfigured texts” grouped by a logical group name.
- Minimal UI overlay:
  - `Cmd+Shift+V` opens clipboard history
  - `Cmd+Shift+B` opens templates list (and lets you switch to Configure)
- Status bar (top-right) tray icon with a small native menu:
  - Clipboard, SavedClip, Settings, Quit
- Paste selected item/template:
  - Select an item in the overlay, press `Enter` (copies to clipboard + triggers `Cmd+V`)
- Start on login toggle inside the UI.

## Run (dev)
1. `cd ClipNinja`
2. `npm install`
3. `npm start`

## macOS permissions
- Hotkeys and paste keystroke injection require Accessibility/Input Monitoring permission.
- First launch may prompt you to allow controlling your computer / input monitoring.

