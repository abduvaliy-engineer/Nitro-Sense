#!/usr/bin/env bash
# NitroSense for Linux installer: packages, the linuwu-sense driver, permissions, Acer's NitroSense artwork,
# the app itself, its launcher and the NitroSense key.
#
#   ./install.sh                 install or update
#   ./install.sh --assets PATH   take the artwork from NitroSense's app.asar, its WindowsApps folder or a
#                                .msix/.appx/.msixbundle/.appxbundle (default: a mounted Windows partition,
#                                else Acer's package from the Microsoft Store)
#   ./install.sh --dev           run the app from this checkout with live reload instead of installing a copy
#   ./install.sh --no-driver     skip building linuwu-sense
#   ./install.sh --uninstall     remove the app, launcher and permissions (the driver stays)
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
PREFIX=${XDG_DATA_HOME:-$HOME/.local/share}/nitrosense
BIN=$HOME/.local/bin
APPS=${XDG_DATA_HOME:-$HOME/.local/share}/applications
ELECTRON_VERSION=43.6.0
LINUWU_REPO=https://github.com/0x7375646F/Linuwu-Sense
LINUWU_COMMIT=73a25ec243a44ba2b1703e8d0a76fa2735062506
LINUWU_VERSION=1.0.0
# Models whose linuwu-sense quirks need a module option.
declare -A LINUWU_OPTIONS=(["Nitro ANV16S-41"]="nitro_v4=1")

ASSETS_SOURCE=""
DEV=0
DRIVER=1
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --assets) ASSETS_SOURCE=${2:?--assets needs a path}; shift ;;
    --dev) DEV=1 ;;
    --no-driver) DRIVER=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\033[1;38;5;208m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
as_root() { sudo "$@"; }
ask() {
  local reply
  read -r -p "$1 [y/N] " reply </dev/tty || return 1
  [[ $reply =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user; it asks for sudo when it needs root."
[ "$(uname -m)" = x86_64 ] || die "Only x86_64 is supported."
MODEL=$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)
APP_DIR=$PREFIX/app
[ "$DEV" -eq 1 ] && APP_DIR=$REPO/app
HYPR_LUA=$HOME/.config/hypr/bindings.lua
HYPR_CONF=$HOME/.config/hypr/hyprland.conf
HYPR_LUA_BIND='o.bind("XF86Presentation", "NitroSense", { launch = "nitrosense" })'
HYPR_CONF_BIND='bind = , XF86Presentation, exec, nitrosense'

# ---------- uninstall ----------

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing NitroSense"
  rm -rf "$PREFIX" "$BIN/nitrosense" "$APPS/nitrosense.desktop"
  for file in "$HYPR_LUA" "$HYPR_CONF"; do
    [ -f "$file" ] && grep -vxF -e "$HYPR_LUA_BIND" -e "$HYPR_CONF_BIND" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  done
  as_root rm -rf /etc/udev/rules.d/70-nitrosense.rules /etc/nitrosense
  as_root udevadm control --reload
  say "Done. linuwu-sense is still installed; remove it with: sudo dkms remove linuwu-sense/$LINUWU_VERSION --all"
  exit 0
fi

case "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)" in
  *Acer*) ;;
  *) warn "This is not an Acer laptop; the controls will not work."; ask "Continue anyway?" || exit 1 ;;
esac

# ---------- packages ----------

driver_installed() { modinfo linuwu_sense >/dev/null 2>&1; }
NEED_DRIVER=0
[ "$DRIVER" -eq 1 ] && ! driver_installed && NEED_DRIVER=1

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

# ---------- linuwu-sense driver ----------

if [ "$NEED_DRIVER" -eq 1 ]; then
  say "Building the linuwu-sense driver (DKMS, rebuilt on kernel updates)"
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
CLEAN="make -C \$kernel_source_dir M=\$dkms_tree/\$PACKAGE_NAME/\$PACKAGE_VERSION/build clean"
AUTOINSTALL="yes"
EOF
  as_root rm -rf "/usr/src/linuwu-sense-$LINUWU_VERSION"
  as_root cp -r "$tmp/linuwu" "/usr/src/linuwu-sense-$LINUWU_VERSION"
  rm -rf "$tmp"
  as_root dkms install "linuwu-sense/$LINUWU_VERSION"

  # linuwu-sense replaces acer_wmi and loads at boot; it saves keyboard state when unloaded at shutdown.
  echo "blacklist acer_wmi" | as_root tee /etc/modprobe.d/blacklist-acer_wmi.conf >/dev/null
  echo "linuwu_sense" | as_root tee /etc/modules-load.d/linuwu_sense.conf >/dev/null
  if [ -n "${LINUWU_OPTIONS[$MODEL]:-}" ] && [ ! -e /etc/modprobe.d/linuwu_sense.conf ]; then
    echo "options linuwu_sense ${LINUWU_OPTIONS[$MODEL]}" | as_root tee /etc/modprobe.d/linuwu_sense.conf >/dev/null
  fi
  as_root install -m644 "/usr/src/linuwu-sense-$LINUWU_VERSION/linuwu_sense.service" /etc/systemd/system/linuwu_sense.service
  as_root systemctl daemon-reload
  as_root systemctl enable --now linuwu_sense.service
  as_root modprobe -r acer_wmi 2>/dev/null || true
  as_root modprobe linuwu_sense
elif [ "$DRIVER" -eq 1 ]; then
  say "linuwu-sense is already installed"
fi

# ---------- permissions ----------

say "Granting the linuwu_sense group access to the controls"
as_root groupadd -f linuwu_sense
NEW_GROUP=0
if ! id -nG "$USER" | grep -qw linuwu_sense; then
  as_root usermod -aG linuwu_sense "$USER"
  NEW_GROUP=1
fi
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

# ---------- app ----------

if [ "$DEV" -eq 0 ]; then
  say "Installing the app to $APP_DIR"
  # Keep artwork extracted by an earlier run.
  [ -d "$APP_DIR/assets/acer" ] && mv "$APP_DIR/assets/acer" "$PREFIX/acer.keep"
  rm -rf "$APP_DIR" && mkdir -p "$PREFIX"
  cp -a "$REPO/app" "$APP_DIR"
  if [ -d "$PREFIX/acer.keep" ]; then
    [ -d "$APP_DIR/assets/acer" ] && rm -rf "$PREFIX/acer.keep" || mv "$PREFIX/acer.keep" "$APP_DIR/assets/acer"
  fi
fi

# ---------- NitroSense artwork ----------

assets_complete() {
  local target
  while IFS=$'\t' read -r target _; do
    [[ -z $target || $target == \#* ]] && continue
    [ -f "$APP_DIR/assets/acer/$target" ] || return 1
  done <"$REPO/data/acer-assets.tsv"
}

extract_assets() {
  python3 -I "$REPO/tools/extract-acer-assets.py" "$1" "$REPO/data/acer-assets.tsv" "$APP_DIR/assets/acer"
}

# Prints the first NitroSense package folder under the given mount points, if any.
find_package() {
  local dir asar
  for dir in "$@"; do
    for asar in "$dir"/Program\ Files/WindowsApps/*NitroSense*/app/resources/app.asar; do
      [ -f "$asar" ] && { echo "${asar%/app/resources/app.asar}"; return 0; }
    done
  done
  return 0
}

if [ -n "$ASSETS_SOURCE" ]; then
  say "Copying NitroSense artwork from $ASSETS_SOURCE"
  extract_assets "$ASSETS_SOURCE"
elif assets_complete; then
  say "NitroSense artwork is already in place"
else
  # A Windows install on this laptop has the newest NitroSense; otherwise fetch it from the Microsoft Store.
  package=$(find_package /run/media/"$USER"/* /media/"$USER"/* /mnt /mnt/*)
  if [ -n "$package" ]; then
    say "Copying NitroSense artwork from the Windows partition"
    extract_assets "$package"
  else
    say "Downloading Acer's NitroSense from the Microsoft Store for its artwork (about 340 MB)"
    tmp=$(mktemp -d)
    if python3 -I "$REPO/tools/fetch-nitrosense.py" "$tmp/NitroSense.msix"; then
      extract_assets "$tmp/NitroSense.msix"
    else
      warn "The download failed. Run again later, or point the installer at a NitroSense package:"
      warn "  ./install.sh --assets <NitroSense .msixbundle / .appx / app.asar>"
    fi
    rm -rf "$tmp"
  fi
fi

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

if [ -f "$HYPR_LUA" ]; then
  grep -q XF86Presentation "$HYPR_LUA" || { printf '\n%s\n' "$HYPR_LUA_BIND" >>"$HYPR_LUA"; say "NitroSense key bound in Hyprland"; }
elif [ -f "$HYPR_CONF" ]; then
  grep -q XF86Presentation "$HYPR_CONF" || { printf '\n%s\n' "$HYPR_CONF_BIND" >>"$HYPR_CONF"; say "NitroSense key bound in Hyprland"; }
fi

# ---------- other tools ----------

if systemctl is-enabled nitro-key-detection.service >/dev/null 2>&1; then
  warn "DAMX's nitro-key-detection service also reacts to the NitroSense key."
  ask "Disable it?" && as_root systemctl disable --now nitro-key-detection.service
fi
if systemctl is-active damx-daemon.service >/dev/null 2>&1; then
  warn "DAMX's daemon is running and also controls fans and keyboard lighting; use one app at a time."
fi

say "NitroSense is installed. Start it from your app launcher, with the NitroSense key, or by running: nitrosense"
[ "$NEW_GROUP" -eq 1 ] && warn "You were added to the linuwu_sense group: log out and back in before using the controls."
[[ :$PATH: == *":$BIN:"* ]] || warn "$BIN is not on your PATH."
exit 0
