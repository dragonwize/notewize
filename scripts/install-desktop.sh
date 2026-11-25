#!/usr/bin/env bash
# Installs the NoteWize launcher and icons for the current user (GNOME/freedesktop).
# Usage: bash scripts/install-desktop.sh   (run `bun run build` first)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

if [[ ! -f "$root/dist-electron/electron/main.js" ]]; then
  echo "Build the app first: bun run build" >&2
  exit 1
fi

for dir in "$root"/build/icons/hicolor/*/; do
  size="$(basename "$dir")"
  mkdir -p "$data/icons/hicolor/$size/apps"
  cp "$dir/apps/notewize.png" "$data/icons/hicolor/$size/apps/notewize.png"
done

mkdir -p "$data/applications"
cat > "$data/applications/notewize.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=NoteWize
GenericName=Markdown Notes
Comment=A minimal, pure-Markdown note-taking app
Exec=env -u ELECTRON_RUN_AS_NODE "$root/node_modules/.bin/electron" "$root" %F
Path=$root
Icon=notewize
Terminal=false
Categories=Office;TextEditor;Utility;
MimeType=text/markdown;
StartupWMClass=NoteWize
StartupNotify=true
DESKTOP

command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$data/icons/hicolor" || true
command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications" || true

echo "Installed NoteWize launcher and icons under $data"
