#!/usr/bin/env bash
# NitroSense for Linux installer: packages, the linuwu-sense driver, permissions, Acer's NitroSense artwork,
# the app itself, its launcher and the NitroSense key.
#
#   ./install.sh                 install or update
#   ./install.sh --assets PATH   take the artwork from NitroSense's app.asar, its WindowsApps folder or a
#                                .msix/.appx/.msixbundle/.appxbundle (default: bundled artwork)
#   ./install.sh --dev           run the app from this checkout with live reload instead of installing a copy
#   ./install.sh --no-driver     skip building linuwu-sense
#   ./install.sh --uninstall     remove the app, launcher and permissions (the driver stays)
#   ./install.sh --update        used by the app's Live Update: no questions, root only when the system part changed
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
PREFIX=${XDG_DATA_HOME:-$HOME/.local/share}/nitrosense
BIN=$HOME/.local/bin
APPS=${XDG_DATA_HOME:-$HOME/.local/share}/applications
AUTOSTART=${XDG_CONFIG_HOME:-$HOME/.config}/autostart
ELECTRON_VERSION=43.6.0
# Until linuwu-sense #154 (gpu_mode, for GPU Operating) is merged upstream, the driver comes from our fork:
# upstream 0x7375646F/Linuwu-Sense at 73a25ec plus only that patch (branch gpu-mode-pinned).
LINUWU_REPO=https://github.com/abduvaliy-engineer/Linuwu-Sense
LINUWU_COMMIT=75ce417b7eb1f85f6c74d83c6148ce61b2cfb6ff
LINUWU_VERSION=1.0.0
LINUWU_SRC=/usr/src/linuwu-sense-$LINUWU_VERSION
# Models whose linuwu-sense quirks need a module option.
declare -A LINUWU_OPTIONS=(["Nitro ANV16S-41"]="nitro_v4=1")

ASSETS_SOURCE=""
DEV=0
DRIVER=1
UNINSTALL=0
UPDATE=0
ROOT_PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root-phase) ROOT_PHASE=${2:?}; shift ;;  # internal: the root half, for user $2
    --assets) ASSETS_SOURCE=${2:?--assets needs a path}; shift ;;
    --dev) DEV=1 ;;
    --no-driver) DRIVER=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --update) UPDATE=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\033[1;38;5;208m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
# Inside the root phase as_root runs directly; the user half asks for root once to run that phase.
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
run_root_phase() {
  local args=(--root-phase "$USER")
  [ "$DRIVER" -eq 0 ] && args+=(--no-driver)
  [ "$UNINSTALL" -eq 1 ] && args+=(--uninstall)
  if [ -t 0 ] && have sudo; then
    sudo bash "$REPO/install.sh" "${args[@]}"
  else
    pkexec /usr/bin/env bash "$REPO/install.sh" "${args[@]}"
  fi
}
ask() {
  local reply
  read -r -p "$1 [y/N] " reply </dev/tty || return 1
  [[ $reply =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

# A linuwu-sense this installer built from another commit gets rebuilt; one installed some other way is left alone.
# Builds record their commit; older ones are recognised by the dkms.conf this installer writes.
driver_outdated() {
  [ -f "$LINUWU_SRC/dkms.conf" ] || return 1
  if [ -f "$LINUWU_SRC/.nitrosense-commit" ]; then
    [ "$(cat "$LINUWU_SRC/.nitrosense-commit")" != "$LINUWU_COMMIT" ]
  else
    grep -qF 'M=$dkms_tree/$PACKAGE_NAME/$PACKAGE_VERSION/build modules' "$LINUWU_SRC/dkms.conf"
  fi
}

[ -n "$ROOT_PHASE" ] || [ "$(id -u)" -ne 0 ] || die "Run this as your normal user; it asks for sudo when it needs root."
[ "$(uname -m)" = x86_64 ] || die "Only x86_64 is supported."
MODEL=$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)
APP_DIR=$PREFIX/app
[ "$DEV" -eq 1 ] && APP_DIR=$REPO/app
HYPR_LUA=$HOME/.config/hypr/bindings.lua
HYPR_CONF=$HOME/.config/hypr/hyprland.conf
HYPR_LUA_BIND='o.bind("XF86Presentation", "NitroSense", { launch = "nitrosense" })'
HYPR_CONF_BIND='bind = , XF86Presentation, exec, nitrosense'
GNOME_KEYS=org.gnome.settings-daemon.plugins.media-keys
GNOME_BIND=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/nitrosense/

# GNOME: the NitroSense key as a custom shortcut (Settings -> Keyboard -> Custom Shortcuts) under our own path, so
# uninstalling removes only ours.
gnome_schema() { have gsettings && grep -qxF "$GNOME_KEYS" <<<"$(gsettings list-schemas 2>/dev/null)"; }
gnome_session() { case ":${XDG_CURRENT_DESKTOP:-}:" in *:GNOME:*) gnome_schema ;; *) return 1 ;; esac; }
gnome_paths() { gsettings get "$GNOME_KEYS" custom-keybindings | grep -o "'[^']*'" | tr -d "'" || true; }
gnome_set_paths() { gsettings set "$GNOME_KEYS" custom-keybindings "[$(sed "/./!d; s/.*/'&'/" | paste -sd, -)]"; }

gnome_bind() {
  local paths path schema=$GNOME_KEYS.custom-keybinding:$GNOME_BIND
  paths=$(gnome_paths)
  grep -qxF "$GNOME_BIND" <<<"$paths" && return 0
  for path in $paths; do
    if [ "$(gsettings get "$GNOME_KEYS.custom-keybinding:$path" binding)" = "'XF86Presentation'" ]; then
      warn "The NitroSense key already has a GNOME shortcut, so it was left as it is."
      return 0
    fi
  done
  if grep -qF "'XF86Presentation'" <<<"$(gsettings list-recursively)"; then
    warn "The NitroSense key is already used by a GNOME setting, so it was left as it is."
    return 0
  fi
  gsettings set "$schema" name "NitroSense" &&
    gsettings set "$schema" command "$BIN/nitrosense" &&
    gsettings set "$schema" binding "XF86Presentation" &&
    printf '%s\n%s\n' "$paths" "$GNOME_BIND" | gnome_set_paths &&
    say "NitroSense key bound in GNOME"
}

gnome_unbind() {
  local paths
  gnome_schema || return 0
  paths=$(gnome_paths)
  grep -qxF "$GNOME_BIND" <<<"$paths" || return 0
  { grep -vxF "$GNOME_BIND" <<<"$paths" || true; } | gnome_set_paths &&
    gsettings reset-recursively "$GNOME_KEYS.custom-keybinding:$GNOME_BIND"
}

# ---------- uninstall ----------

if [ -n "$ROOT_PHASE" ] && [ "$UNINSTALL" -eq 1 ]; then
  rm -rf /etc/udev/rules.d/70-nitrosense.rules /etc/nitrosense
  udevadm control --reload
  exit 0
fi

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing NitroSense"
  "$BIN/nitrosense" --quit 2>/dev/null || true
  rm -rf "$PREFIX" "$BIN/nitrosense" "$APPS/nitrosense.desktop" "$AUTOSTART/nitrosense.desktop"
  for file in "$HYPR_LUA" "$HYPR_CONF"; do
    [ -f "$file" ] && grep -vxF -e "$HYPR_LUA_BIND" -e "$HYPR_CONF_BIND" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  done
  gnome_unbind || warn "Could not remove the NitroSense key's GNOME shortcut."
  run_root_phase
  say "Done. linuwu-sense is still installed; remove it with: sudo dkms remove linuwu-sense/$LINUWU_VERSION --all"
  exit 0
fi

[ -n "$ROOT_PHASE" ] || [ "$UPDATE" -eq 1 ] || case "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)" in
  *Acer*) ;;
  *) warn "This is not an Acer laptop; the controls will not work."; ask "Continue anyway?" || exit 1 ;;
esac

# ---------- root half: packages, driver, permissions (one sudo / pkexec prompt) ----------

if [ -n "$ROOT_PHASE" ]; then
  # ---------- packages ----------

  driver_installed() { modinfo linuwu_sense >/dev/null 2>&1; }
  NEED_DRIVER=0 REBUILD=0
  if [ "$DRIVER" -eq 1 ]; then
    if ! driver_installed; then NEED_DRIVER=1
    elif driver_outdated; then NEED_DRIVER=1 REBUILD=1
    fi
  fi

  say "Installing packages"
  if have pacman; then
    pkgs=(python git unzip)
    pacman -Si electron43 >/dev/null 2>&1 && pkgs+=(electron43)
    have hyprctl && pkgs+=(hyprpicker)
    if [ "$NEED_DRIVER" -eq 1 ]; then
      kernel_pkg=$(pacman -Qqo "/usr/lib/modules/$(uname -r)/vmlinuz" 2>/dev/null || echo linux)
      pkgs+=(dkms base-devel "$kernel_pkg-headers")
    fi
    as_root pacman -S --needed --noconfirm "${pkgs[@]}"
  elif have apt-get; then
    pkgs=(python3 git unzip curl)
    [ "$NEED_DRIVER" -eq 1 ] && pkgs+=(dkms build-essential "linux-headers-$(uname -r)")
    as_root apt-get install -y "${pkgs[@]}"
  elif have dnf; then
    pkgs=(python3 git unzip curl)
    [ "$NEED_DRIVER" -eq 1 ] && pkgs+=(dkms gcc make "kernel-devel-$(uname -r)")
    as_root dnf install -y "${pkgs[@]}"
  else
    warn "Unknown package manager: install python3, git, unzip, curl (and dkms + kernel headers for the driver)."
  fi

  # ---------- linuwu-sense driver ----------

  if [ "$NEED_DRIVER" -eq 1 ]; then
    if [ "$REBUILD" -eq 1 ]; then say "Updating the linuwu-sense driver (DKMS)"
    else say "Building the linuwu-sense driver (DKMS, rebuilt on kernel updates)"
    fi
    if have mokutil && mokutil --sb-state 2>/dev/null | grep -q enabled; then
      warn "Secure Boot is on: the module must be signed with an enrolled key or it will not load."
    fi
    tmp=$(mktemp -d)
    git clone -q "$LINUWU_REPO" "$tmp/linuwu"
    git -C "$tmp/linuwu" checkout -q "$LINUWU_COMMIT"
    # Recent kernels reject these fortified strncpy calls; the copies are length-bounded anyway.
    sed -i 's/\bstrncpy(/memcpy(/g' "$tmp/linuwu/src/linuwu_sense.c"
    cat > "$tmp/linuwu/dkms.conf" <<EOF
  PACKAGE_NAME="linuwu-sense"
  PACKAGE_VERSION="$LINUWU_VERSION"
  BUILT_MODULE_NAME[0]="linuwu_sense"
  BUILT_MODULE_LOCATION[0]="src"
  DEST_MODULE_LOCATION[0]="/kernel/drivers/platform/x86"
  MAKE[0]="make -C \$kernel_source_dir M=\$dkms_tree/\$PACKAGE_NAME/\$PACKAGE_VERSION/build modules"
  AUTOINSTALL="yes"
EOF
    echo "$LINUWU_COMMIT" >"$tmp/linuwu/.nitrosense-commit"
    as_root dkms remove "linuwu-sense/$LINUWU_VERSION" --all >/dev/null 2>&1 || true
    as_root rm -rf "$LINUWU_SRC"
    as_root cp -r "$tmp/linuwu" "$LINUWU_SRC"
    rm -rf "$tmp"
    as_root dkms install "linuwu-sense/$LINUWU_VERSION"

    # linuwu-sense replaces acer_wmi and loads at boot; it saves keyboard state when unloaded at shutdown.
    echo "blacklist acer_wmi" | as_root tee /etc/modprobe.d/blacklist-acer_wmi.conf >/dev/null
    echo "linuwu_sense" | as_root tee /etc/modules-load.d/linuwu_sense.conf >/dev/null
    if [ -n "${LINUWU_OPTIONS[$MODEL]:-}" ] && [ ! -e /etc/modprobe.d/linuwu_sense.conf ]; then
      echo "options linuwu_sense ${LINUWU_OPTIONS[$MODEL]}" | as_root tee /etc/modprobe.d/linuwu_sense.conf >/dev/null
    fi
    as_root install -m644 "$LINUWU_SRC/linuwu_sense.service" /etc/systemd/system/linuwu_sense.service
    as_root systemctl daemon-reload
    as_root systemctl enable --now linuwu_sense.service
    as_root modprobe -r acer_wmi 2>/dev/null || true
    as_root modprobe linuwu_sense
    # The loaded module keeps running until the next boot; reloading it now would reset fans and lighting.
    [ "$REBUILD" -eq 1 ] && warn "The updated linuwu-sense driver loads when you restart the computer."
  elif [ "$DRIVER" -eq 1 ]; then
    say "linuwu-sense is already installed"
  fi

  # ---------- permissions ----------

  say "Granting the linuwu_sense group access to the controls"
  as_root groupadd -f linuwu_sense
  id -nG "$ROOT_PHASE" | grep -qw linuwu_sense || usermod -aG linuwu_sense "$ROOT_PHASE"
  as_root install -m644 "$REPO/data/70-nitrosense.rules" /etc/udev/rules.d/70-nitrosense.rules
  as_root udevadm control --reload
  as_root udevadm trigger --action=bind /sys/devices/platform/acer-wmi 2>/dev/null || true
  as_root udevadm trigger --subsystem-match=hidraw --action=add
  [ -d /sys/module/linuwu_sense ] && as_root udevadm trigger --action=add /sys/module/linuwu_sense

  # The CPU's rated maximum clock (SMBIOS type 4, max speed at offset 0x14) for the Home gauges.
  max_mhz=$(as_root od -An -tu2 -j20 -N2 /sys/firmware/dmi/entries/4-0/raw 2>/dev/null | tr -d ' ' || true)
  if [ -n "$max_mhz" ] && [ "$max_mhz" -gt 0 ]; then
    as_root install -d /etc/nitrosense
    echo "$max_mhz" | as_root tee /etc/nitrosense/cpu_max_mhz >/dev/null
  fi

  exit 0
fi

# Fail before changing the system if this checkout/release is incomplete.
python3 -I "$REPO/tools/check-acer-assets.py" "$REPO/data/acer-assets.tsv" "$REPO/app/assets/acer"

NEW_GROUP=0
id -nG "$USER" | grep -qw linuwu_sense || NEW_GROUP=1
# An update only needs root when the system part is missing or changed.
system_current() {
  modinfo linuwu_sense >/dev/null 2>&1 && ! { [ "$DRIVER" -eq 1 ] && driver_outdated; } && [ "$NEW_GROUP" -eq 0 ] \
    && [ -e /etc/nitrosense/cpu_max_mhz ] && cmp -s "$REPO/data/70-nitrosense.rules" /etc/udev/rules.d/70-nitrosense.rules
}
if [ "$UPDATE" -eq 1 ] && system_current; then
  say "Driver and permissions are up to date"
else
  say "Root access is needed once for packages, the driver and permissions"
  run_root_phase
fi

# Electron: the distribution's electron43, otherwise Electron's own build.
if have electron43; then
  ELECTRON=$(command -v electron43)
else
  ELECTRON=$PREFIX/electron/electron
  if [ ! -x "$ELECTRON" ]; then
    say "Downloading Electron $ELECTRON_VERSION"
    tmp=$(mktemp -d)
    curl -fL --progress-bar -o "$tmp/electron.zip" \
      "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-x64.zip"
    rm -rf "$PREFIX/electron" && mkdir -p "$PREFIX/electron"
    unzip -q "$tmp/electron.zip" -d "$PREFIX/electron"
    rm -rf "$tmp"
  fi
fi

# ---------- app ----------

if [ "$DEV" -eq 0 ]; then
  say "Installing the app to $APP_DIR"
  rm -rf "$APP_DIR" && mkdir -p "$PREFIX"
  cp -a "$REPO/app" "$APP_DIR"
fi

# ---------- NitroSense artwork ----------

# Optional local artwork override; installation never contacts Microsoft Store.
if [ -n "$ASSETS_SOURCE" ]; then
  say "Copying NitroSense artwork from $ASSETS_SOURCE"
  python3 -I "$REPO/tools/extract-acer-assets.py" "$ASSETS_SOURCE" "$REPO/data/acer-assets.tsv" "$APP_DIR/assets/acer"
fi
python3 -I "$REPO/tools/check-acer-assets.py" "$REPO/data/acer-assets.tsv" "$APP_DIR/assets/acer"
say "Bundled NitroSense artwork is in place"

# ---------- launcher, desktop entry, NitroSense key ----------

say "Adding the launcher and desktop entry"
mkdir -p "$BIN" "$APPS"
if [ "$DEV" -eq 1 ]; then
  printf '#!/bin/sh\n# Development: live reload from the checkout.\ncd "%s" && exec "%s" . --dev "$@"\n' "$APP_DIR" "$ELECTRON" >"$BIN/nitrosense"
else
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$ELECTRON" "$APP_DIR" >"$BIN/nitrosense"
fi
chmod +x "$BIN/nitrosense"
install -m644 "$REPO/data/nitrosense.desktop" "$APPS/nitrosense.desktop"
# Like NitroSense, it starts hidden at login so App Sync and the mode-change flash keep working.
mkdir -p "$AUTOSTART"
printf '[Desktop Entry]\nType=Application\nName=NitroSense\nExec=%s --hidden\nNoDisplay=true\n' "$BIN/nitrosense" >"$AUTOSTART/nitrosense.desktop"

if [ -f "$HYPR_LUA" ]; then
  grep -q XF86Presentation "$HYPR_LUA" || { printf '\n%s\n' "$HYPR_LUA_BIND" >>"$HYPR_LUA"; say "NitroSense key bound in Hyprland"; }
elif [ -f "$HYPR_CONF" ]; then
  grep -q XF86Presentation "$HYPR_CONF" || { printf '\n%s\n' "$HYPR_CONF_BIND" >>"$HYPR_CONF"; say "NitroSense key bound in Hyprland"; }
fi
if gnome_session; then
  gnome_bind || warn "Could not bind the NitroSense key in GNOME; add a custom shortcut for $BIN/nitrosense in Settings."
fi
case ":${XDG_CURRENT_DESKTOP:-}:" in
  *:KDE:*) warn "KDE Plasma can't bind the NitroSense key (Qt has no name for XF86Presentation); use the launcher or another shortcut." ;;
esac

# ---------- other tools ----------

if systemctl is-enabled nitro-key-detection.service >/dev/null 2>&1; then
  warn "DAMX's nitro-key-detection service also reacts to the NitroSense key."
  [ -t 0 ] && ask "Disable it?" && as_root systemctl disable --now nitro-key-detection.service
fi
if systemctl is-active damx-daemon.service >/dev/null 2>&1; then
  warn "DAMX's daemon is running and also controls fans and keyboard lighting; use one app at a time."
fi

say "NitroSense is installed. Start it from your app launcher, with the NitroSense key, or by running: nitrosense"
[ "$NEW_GROUP" -eq 1 ] && warn "You were added to the linuwu_sense group: log out and back in before using the controls."
[[ :$PATH: == *":$BIN:"* ]] || warn "$BIN is not on your PATH."
exit 0
