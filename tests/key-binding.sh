#!/usr/bin/env bash
# The NitroSense key binding (data/nitrosense-setup, used by install.sh and the AUR package) against throwaway
# settings: a temp HOME for Hyprland's config, and for GNOME a minimal copy of its media-keys schema with GSettings'
# keyfile backend in a temp dir, so no real desktop settings are touched.
# Usage: bash tests/key-binding.sh [data/nitrosense-setup]   (needs gsettings and glib-compile-schemas)
set -euo pipefail
SETUP=${1:-$(dirname "$0")/../data/nitrosense-setup}
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
export XDG_CURRENT_DESKTOP=ubuntu:GNOME HOME=$work/home
mkdir -p "$HOME/.config/hypr"
printf 'o.bind("SUPER + RETURN", "Terminal", { launch = "alacritty" })\n' >"$HOME/.config/hypr/bindings.lua"
NS_LAUNCHER=/home/test/.local/bin/nitrosense
say() { echo "SAY: $*"; }
warn() { echo "WARN: $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# shellcheck source=data/nitrosense-setup
. "$SETUP"

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
[ "$(gsettings get "$ours" command)" = "'$NS_LAUNCHER'" ] || fail "command"
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

# Hyprland (plus GNOME, since this is a GNOME session): bound once, and removing it keeps the user's own lines.
lua=$HOME/.config/hypr/bindings.lua
key_bind >/dev/null
key_bind >/dev/null
[ "$(grep -c XF86Presentation "$lua")" = 1 ] || fail "Hyprland binding added $(grep -c XF86Presentation "$lua") times"
[ "$(list)" = "['$GNOME_BIND']" ] || fail "key_bind didn't bind GNOME: $(list)"
key_unbind
grep -q XF86Presentation "$lua" && fail "key_unbind left the Hyprland binding"
grep -q '"Terminal"' "$lua" || fail "key_unbind removed the user's own binding"
empty "key_unbind:"
printf 'o.bind("XF86Presentation", "Mine", { launch = "foo" })\n' >>"$lua"
key_bind >/dev/null
[ "$(grep -c XF86Presentation "$lua")" = 1 ] || fail "key_bind added a second binding next to the user's own"

echo "all passed"
