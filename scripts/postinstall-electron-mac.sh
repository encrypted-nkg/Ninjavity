#!/usr/bin/env bash
# On macOS Tahoe+, XProtect may block Electron.app when its notarization
# ticket is revoked or the signature is incomplete after extract. Ad-hoc
# re-sign the local Electron runtime so `npm start` can run on this machine.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/node_modules/electron/dist/Electron.app"

if [[ ! -d "$APP" ]]; then
  echo "postinstall-electron-mac: Electron.app not found (skip)"
  exit 0
fi

echo "postinstall-electron-mac: ad-hoc signing Electron.app for local macOS..."
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP"
echo "postinstall-electron-mac: done"
