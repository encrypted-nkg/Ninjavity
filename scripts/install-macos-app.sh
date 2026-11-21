#!/usr/bin/env bash
# Build ClipNinja as a real macOS application bundle and install it into /Applications.
#
# The result is a normal .app: it runs without Node or the electron CLI, appears as "ClipNinja"
# (not "Electron") in System Settings → Privacy & Security, and can be added as a login item.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="ClipNinja"
DEST="/Applications/${APP_NAME}.app"

# Default to this Mac's own architecture. A universal build doubles the download and the on-disk
# footprint by several GB and only matters when shipping the app to other machines.
ARCH_FLAG="--$(uname -m)"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  ARCH_FLAG="--universal"
fi

AVAIL_MB="$(df -m / | awk 'NR==2 {print $4}')"
NEEDED_MB=2000
[[ "$ARCH_FLAG" == "--universal" ]] && NEEDED_MB=5000
if (( AVAIL_MB < NEEDED_MB )); then
  echo "Only ${AVAIL_MB} MB free on / — the build needs roughly ${NEEDED_MB} MB." >&2
  echo "Free up some space and run this again." >&2
  exit 1
fi

echo "==> Building ${APP_NAME}.app (${ARCH_FLAG#--})"
npx electron-builder --mac dir "$ARCH_FLAG"

BUILT="$(find "$ROOT/release" -maxdepth 2 -name "${APP_NAME}.app" -type d -newermt '-10 minutes' | head -n 1)"
if [[ -z "$BUILT" ]]; then
  echo "Build did not produce ${APP_NAME}.app under release/" >&2
  exit 1
fi

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "==> Quitting the running ${APP_NAME}"
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || pkill -x "$APP_NAME" || true
  sleep 1
fi

echo "==> Installing to ${DEST}"
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"

# Without a Developer ID the bundle needs an ad-hoc signature, or macOS refuses to launch it
# and the Automation/Accessibility grants are dropped on every rebuild.
echo "==> Ad-hoc signing"
codesign --force --deep --sign - "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true

echo "==> Done. Launching."
open "$DEST"

cat <<'NOTE'

One-time macOS permissions (System Settings → Privacy & Security):
  • Accessibility → enable ClipNinja   (required to paste into the focused app)
  • Automation    → ClipNinja → System Events

Because this build is ad-hoc signed, those grants are tied to the exact binary: re-run
`npm run app:install` and you may have to toggle the two switches off and on again.
NOTE
