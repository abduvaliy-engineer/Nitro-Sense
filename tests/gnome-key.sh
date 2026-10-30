#!/usr/bin/env bash
# install.sh's GNOME binding of the NitroSense key, against a throwaway settings file: a minimal copy of GNOME's
# media-keys schema and GSettings' keyfile backend in a temp dir, so no real desktop settings are touched.
# Usage: bash tests/gnome-key.sh [install.sh]   (needs gsettings and glib-compile-schemas)
set -euo pipefail
INSTALL=${1:-$(dirname "$0")/../install.sh}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/schemas"
cat >"$work/schemas/test.gschema.xml" <<'EOF'
<schemalist>
  <schema id="org.gnome.settings-daemon.plugins.media-keys" path="/org/gnome/settings-daemon/plugins/media-keys/">
    <key name="custom-keybindings" type="as"><default>[]</default></key>
    <key name="screensaver" type="as"><default>['&lt;Super&gt;l']</default></key>
  </schema>
  <schema id="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding">
    <key name="name" type="s"><default>''</default></key>
    <key name="binding" type="s"><default>''</default></key>
    <key name="command" type="s"><default>''</default></key>
  </schema>
</schemalist>
EOF
glib-compile-schemas "$work/schemas"
export GSETTINGS_SCHEMA_DIR=$work/schemas GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=$work/config
export XDG_CURRENT_DESKTOP=ubuntu:GNOME
BIN=/home/test/.local/bin
say() { echo "SAY: $*"; }
warn() { echo "WARN: $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
eval "$(sed -n '/^GNOME_KEYS=/,/^# ---------- uninstall/p' "$INSTALL")"

K=org.gnome.settings-daemon.plugins.media-keys
ours=$K.custom-keybinding:$GNOME_BIND
other=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/
fail() { echo "FAIL: $*"; exit 1; }
list() { gsettings get $K custom-keybindings; }
empty() { case "$(list)" in "@as []" | "[]") ;; *) fail "${1:-list} not empty: $(list)" ;; esac; }

gnome_session || fail "GNOME not detected in ubuntu:GNOME"
(XDG_CURRENT_DESKTOP=Hyprland; gnome_session) && fail "GNOME detected in Hyprland"

gnome_bind
[ "$(list)" = "['$GNOME_BIND']" ] || fail "bind into an empty list: $(list)"
[ "$(gsettings get "$ours" binding)" = "'XF86Presentation'" ] || fail "binding"
[ "$(gsettings get "$ours" command)" = "'$BIN/nitrosense'" ] || fail "command"
[ "$(gsettings get "$ours" name)" = "'NitroSense'" ] || fail "name"

gnome_bind
[ "$(list)" = "['$GNOME_BIND']" ] || fail "bind twice: $(list)"

gsettings set "$K.custom-keybinding:$other" binding "<Super>t"
gsettings set $K custom-keybindings "['$other', '$GNOME_BIND']"
gnome_unbind
[ "$(list)" = "['$other']" ] || fail "unbind keeps other shortcuts: $(list)"
[ "$(gsettings get "$ours" binding)" = "''" ] || fail "unbind resets our keys"
[ "$(gsettings get "$K.custom-keybinding:$other" binding)" = "'<Super>t'" ] || fail "unbind changed another shortcut"

gnome_bind
[ "$(list)" = "['$other', '$GNOME_BIND']" ] || fail "bind appends: $(list)"
gnome_unbind

gsettings set "$K.custom-keybinding:$other" binding "XF86Presentation"
grep -q '^WARN: The NitroSense key already has a GNOME shortcut' <<<"$(gnome_bind)" || fail "no warning for a taken key"
[ "$(list)" = "['$other']" ] || fail "bound a key another shortcut has: $(list)"

gsettings set "$K.custom-keybinding:$other" binding "<Super>t"
gsettings set $K screensaver "['XF86Presentation']"
grep -q '^WARN: The NitroSense key is already used by a GNOME setting' <<<"$(gnome_bind)" || fail "no warning for a built-in"
[ "$(list)" = "['$other']" ] || fail "bound a key a built-in has: $(list)"
gsettings reset $K screensaver

gnome_unbind
[ "$(list)" = "['$other']" ] || fail "unbind without our shortcut changed the list: $(list)"

gsettings set $K custom-keybindings "['$GNOME_BIND']"
gnome_unbind
empty "unbind of the last shortcut:"

echo "all passed"
