#!/usr/bin/env bash
# NitroSense for Linux installer: packages, the linuwu-sense driver, permissions, Acer's NitroSense artwork,
# the app itself (built here with cargo), its launcher and the NitroSense key.
#
#   ./install.sh                 install or update
#   ./install.sh --assets PATH   take the artwork from NitroSense's app.asar, its WindowsApps folder or a
#                                .msix/.appx/.msixbundle/.appxbundle (default: a mounted Windows partition,
#                                else Acer's package from the Microsoft Store)
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
# The app is built from this source with cargo. Its build folder is kept between updates, so only what changed is
# compiled again.
BUILD_DIR=${XDG_CACHE_HOME:-$HOME/.cache}/nitrosense/build
# Until linuwu-sense #154 (gpu_mode, for GPU Operating) is merged upstream, the driver comes from our fork:
# upstream 0x7375646F/Linuwu-Sense at 73a25ec plus only that patch (branch gpu-mode-pinned).
LINUWU_REPO=https://github.com/abduvaliy-engineer/Linuwu-Sense
LINUWU_COMMIT=75ce417b7eb1f85f6c74d83c6148ce61b2cfb6ff
LINUWU_VERSION=1.0.0
LINUWU_SRC=/usr/src/linuwu-sense-$LINUWU_VERSION
# The Mode Switch Key service runs as root, so it lives outside the user's copy.
MODEKEY_DIR=/usr/local/lib/nitrosense-linux
MODEKEY=$MODEKEY_DIR/nitrosense-modekey
MODEKEY_UNIT=/etc/systemd/system/nitrosense-modekey@.service
# Models whose linuwu-sense quirks need a module option.
declare -A LINUWU_OPTIONS=(["Nitro ANV16S-41"]="nitro_v4=1")

ASSETS_SOURCE=""
DEV=0
DRIVER=1
UNINSTALL=0
UPDATE=0
ROOT_PHASE=""
STAGE=""
NEED_RUST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root-phase) ROOT_PHASE=${2:?}; shift ;;  # internal: the root half, for user $2
    --stage) STAGE=${2:?}; shift ;;              # internal: where the root half puts Windows' NitroSense
    --need-rust) NEED_RUST=1 ;;                  # internal: the user has no usable cargo, so the root half installs Rust
    --assets) ASSETS_SOURCE=${2:?--assets needs a path}; shift ;;
    --dev) DEV=1 ;;
    --no-driver) DRIVER=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --update) UPDATE=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  [ -n "$STAGE" ] && args+=(--stage "$STAGE")
  [ "$NEED_RUST" -eq 1 ] && args+=(--need-rust)
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
# The Mode Switch Key service's unit, pointing at this install's copy of the service.
modekey_unit() { sed "s|@MODEKEY@|$MODEKEY|" "$REPO/data/nitrosense-modekey@.service"; }

# The Rust version the app needs (rust-version in Cargo.toml).
rust_wanted() { sed -n 's/^rust-version = "\(.*\)"/\1/p' "$REPO/Cargo.toml"; }
# Whether version $1 is $2 or newer.
version_at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
# Whether this user's cargo can build the app.
rust_ready() { have cargo && version_at_least "$(cargo --version | awk '{print $2}')" "$(rust_wanted)"; }
# Ubuntu ships newer Rust as versioned packages (cargo-1.85, ...) under /usr/lib/rust-<version>: when the default
# cargo is missing or too old, the newest of those goes first on PATH.
use_versioned_rust() {
  rust_ready && return 0
  local dir
  for dir in $(printf '%s\n' /usr/lib/rust-1.*/bin | sort -V -r); do
    [ -x "$dir/cargo" ] || continue
    PATH=$dir:$PATH
    rust_ready && return 0
    PATH=${PATH#"$dir:"}
  done
  return 1
}
# The apt package with a cargo new enough: the distribution's own (Debian 13: 1.85), or else Ubuntu's newest
# versioned one (Ubuntu 24.04's own cargo is 1.75).
apt_cargo() {
  local candidate versioned
  candidate=$(apt-cache policy cargo 2>/dev/null | sed -n 's/^ *Candidate: \([0-9.]*\).*/\1/p' | head -n1)
  if [ -n "$candidate" ] && version_at_least "$candidate" "$(rust_wanted)"; then
    echo cargo
    return
  fi
  versioned=$(apt-cache search --names-only '^cargo-1\.[0-9]+$' 2>/dev/null | awk '{print $1}' | sort -V | tail -n1)
  if [ -n "$versioned" ] && version_at_least "${versioned#cargo-}" "$(rust_wanted)"; then
    echo "$versioned"
  else
    echo cargo
  fi
}
# The libraries the window is built against (WebKitGTK and GTK 3, with their headers).
libraries_ready() { have pkg-config && pkg-config --exists webkit2gtk-4.1 gtk+-3.0; }

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
# cargo from rustup lives in the user's home, which a launcher's PATH may not have.
[ -n "$ROOT_PHASE" ] || [[ :$PATH: == *":$HOME/.cargo/bin:"* ]] || PATH=$HOME/.cargo/bin:$PATH
# The NitroSense key binding and the group join.
NS_LAUNCHER=$BIN/nitrosense
# shellcheck source=data/nitrosense-setup
. "$REPO/data/nitrosense-setup"
# Finding and checking NitroSense's artwork.
NS_ROOT=$REPO
# shellcheck source=data/nitrosense-artwork
. "$REPO/data/nitrosense-artwork"

# ---------- uninstall ----------

if [ -n "$ROOT_PHASE" ] && [ "$UNINSTALL" -eq 1 ]; then
  systemctl stop 'nitrosense-modekey@*.service' 2>/dev/null || true
  rm -rf /etc/udev/rules.d/70-nitrosense.rules /etc/nitrosense "$MODEKEY_UNIT" "$MODEKEY_DIR"
  systemctl daemon-reload 2>/dev/null || true
  udevadm control --reload
  exit 0
fi

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing NitroSense"
  "$BIN/nitrosense" --quit 2>/dev/null || true
  rm -rf "$PREFIX" "$BUILD_DIR" "$BIN/nitrosense" "$APPS/nitrosense.desktop" "$AUTOSTART/nitrosense.desktop"
  key_unbind
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
  # The window is WebKitGTK; building it takes a C toolchain, pkg-config and the libraries' headers.
  if have pacman; then
    pkgs=(python git unzip webkit2gtk-4.1 gtk3 gcc pkgconf)
    [ "$NEED_RUST" -eq 1 ] && pkgs+=(rust)
    have hyprctl && pkgs+=(hyprpicker)
    if [ "$NEED_DRIVER" -eq 1 ]; then
      kernel_pkg=$(pacman -Qqo "/usr/lib/modules/$(uname -r)/vmlinuz" 2>/dev/null || echo linux)
      pkgs+=(dkms base-devel "$kernel_pkg-headers")
    fi
    as_root pacman -S --needed --noconfirm "${pkgs[@]}"
  elif have apt-get; then
    pkgs=(python3 git unzip curl build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev)
    [ "$NEED_RUST" -eq 1 ] && pkgs+=("$(apt_cargo)")
    [ "$NEED_DRIVER" -eq 1 ] && pkgs+=(dkms "linux-headers-$(uname -r)")
    as_root apt-get install -y "${pkgs[@]}"
  elif have dnf; then
    pkgs=(python3 git unzip curl gcc pkgconf-pkg-config webkit2gtk4.1-devel gtk3-devel)
    [ "$NEED_RUST" -eq 1 ] && pkgs+=(cargo)
    [ "$NEED_DRIVER" -eq 1 ] && pkgs+=(dkms make "kernel-devel-$(uname -r)")
    as_root dnf install -y "${pkgs[@]}"
  else
    warn "Unknown package manager: install python3, git, unzip, curl, Rust (cargo), a C compiler, pkg-config and the WebKitGTK 4.1 and GTK 3 development files (and dkms + kernel headers for the driver)."
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
  # The Mode Switch Key service, which udev starts from the hidraw trigger below for keyboards that report the key.
  as_root install -Dm755 "$REPO/data/nitrosense-modekey" "$MODEKEY"
  modekey_unit | as_root tee "$MODEKEY_UNIT" >/dev/null
  if [ -d /run/systemd/system ]; then
    as_root systemctl daemon-reload
    as_root systemctl try-restart 'nitrosense-modekey@*.service'
  fi
  as_root install -m644 "$REPO/data/70-nitrosense.rules" /etc/udev/rules.d/70-nitrosense.rules
  as_root udevadm control --reload
  as_root udevadm trigger --action=bind /sys/devices/platform/acer-wmi 2>/dev/null || true
  as_root udevadm trigger --action=add --subsystem-match=platform-profile
  as_root udevadm trigger --subsystem-match=hidraw --action=add
  [ -d /sys/module/linuwu_sense ] && as_root udevadm trigger --action=add /sys/module/linuwu_sense

  # The CPU's rated maximum clock (SMBIOS type 4, max speed at offset 0x14) for the Home gauges.
  max_mhz=$(as_root od -An -tu2 -j20 -N2 /sys/firmware/dmi/entries/4-0/raw 2>/dev/null | tr -d ' ' || true)
  if [ -n "$max_mhz" ] && [ "$max_mhz" -gt 0 ]; then
    as_root install -d /etc/nitrosense
    echo "$max_mhz" | as_root tee /etc/nitrosense/cpu_max_mhz >/dev/null
  fi

  # NitroSense installed on Windows has the newest artwork. Unmounted Windows drives are mounted read-only
  # in a private folder for a moment; its app.asar goes to the stage folder for the user half.
  if [ -n "$STAGE" ]; then
    say "Looking for NitroSense on Windows drives"
    while read -r dev fstype mountpoint; do
      [ "$fstype" = ntfs ] && [ -z "$mountpoint" ] || continue
      mnt=$(mktemp -d /run/nitrosense-windows.XXXXXX)
      if mount -o ro "$dev" "$mnt" 2>/dev/null || mount -t ntfs3 -o ro "$dev" "$mnt" 2>/dev/null; then
        package=$(artwork_find "$mnt")
        if [ -n "$package" ]; then
          mkdir -p "$STAGE/app/resources"
          cp -r "$package/app/resources/app.asar" "$STAGE/app/resources/"
          [ -d "$package/app/resources/app.asar.unpacked" ] && cp -r "$package/app/resources/app.asar.unpacked" "$STAGE/app/resources/"
          chown -R "$ROOT_PHASE": "$STAGE"
        fi
        umount "$mnt"
      fi
      rmdir "$mnt"
      [ -f "$STAGE/app/resources/app.asar" ] && break
    done < <(lsblk -rpno NAME,FSTYPE,MOUNTPOINT)
  fi
  exit 0
fi

NEW_GROUP=0
id -nG "$USER" | grep -qw linuwu_sense || NEW_GROUP=1
if [ "$UPDATE" -eq 0 ] && [ -z "$ASSETS_SOURCE" ]; then
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT
fi
# An update only needs root when the system part is missing or changed.
system_current() {
  modinfo linuwu_sense >/dev/null 2>&1 && ! { [ "$DRIVER" -eq 1 ] && driver_outdated; } && [ "$NEW_GROUP" -eq 0 ] \
    && [ -e /etc/nitrosense/cpu_max_mhz ] && cmp -s "$REPO/data/70-nitrosense.rules" /etc/udev/rules.d/70-nitrosense.rules \
    && cmp -s "$REPO/data/nitrosense-modekey" "$MODEKEY" && modekey_unit | cmp -s - "$MODEKEY_UNIT" \
    && libraries_ready && [ "$NEED_RUST" -eq 0 ]
}
use_versioned_rust || NEED_RUST=1
if [ "$UPDATE" -eq 1 ] && system_current; then
  say "Driver and permissions are up to date"
else
  say "Root access is needed once for packages, the driver and permissions"
  run_root_phase
fi

# ---------- build ----------

if ! use_versioned_rust; then
  have cargo && die "Rust $(rust_wanted) or newer is needed to build NitroSense; this cargo is $(cargo --version | awk '{print $2}'). Install a newer one with rustup (https://rustup.rs), then run this again."
  die "cargo (Rust) is needed to build NitroSense. Install it with your package manager or rustup (https://rustup.rs), then run this again."
fi
libraries_ready || die "The WebKitGTK 4.1 and GTK 3 development files are needed to build NitroSense."
# A development install builds in the checkout (target/), so the app finds the checkout's app/ folder.
TARGET_DIR=$BUILD_DIR
[ "$DEV" -eq 1 ] && TARGET_DIR=$REPO/target
say "Building NitroSense (a minute or two the first time)"
cargo build --release --locked --manifest-path "$REPO/Cargo.toml" --target-dir "$TARGET_DIR"
BUILT=$TARGET_DIR/release
[ -x "$BUILT/nitrosense" ] && [ -x "$BUILT/nitrosense-ui" ] || die "The build didn't produce the app."

# An earlier version ran on Electron. Stop a running copy before its files go (not during a Live Update: the app
# running it restarts itself afterwards).
WAS_ELECTRON=0
# Its launcher was a script naming Electron; the new one is a link to the program.
[ ! -L "$BIN/nitrosense" ] && grep -qs electron "$BIN/nitrosense" && WAS_ELECTRON=1
WAS_RUNNING=0
if [ "$UPDATE" -eq 0 ]; then
  if pgrep -u "$(id -u)" -x nitrosense >/dev/null || pgrep -u "$(id -u)" -f 'electron.*nitrosense' >/dev/null; then
    WAS_RUNNING=1
    "$BIN/nitrosense" --quit >/dev/null 2>&1 || true
  fi
fi

# ---------- app ----------

if [ "$DEV" -eq 0 ]; then
  say "Installing the app to $APP_DIR"
  # Keep artwork extracted by an earlier run.
  [ -d "$APP_DIR/assets/acer" ] && mv "$APP_DIR/assets/acer" "$PREFIX/acer.keep"
  rm -rf "$APP_DIR" && mkdir -p "$PREFIX"
  # The Electron an earlier version downloaded. A Live Update from that version still needs it once, to restart.
  [ "$UPDATE" -eq 1 ] && [ "$WAS_ELECTRON" -eq 1 ] || rm -rf "$PREFIX/electron"
  cp -a "$REPO/app" "$APP_DIR"
  # The background part (nitrosense) and the window (nitrosense-ui) sit next to app/, where they look for it.
  # install replaces the files instead of writing into them, so a running copy keeps working until it restarts.
  install -m755 "$BUILT/nitrosense" "$BUILT/nitrosense-ui" "$PREFIX/"
  if [ "$UPDATE" -eq 1 ] && [ "$WAS_ELECTRON" -eq 1 ]; then
    # A Live Update from the Electron version: that app restarts itself as "electron <app folder>" when this is
    # done. These two files make that start hand over to the new program and leave.
    printf '{ "name": "nitrosense-linux", "main": "main.js" }\n' >"$APP_DIR/package.json"
    {
      echo '// Left by the update from the Electron version: start the new NitroSense and quit.'
      echo 'const { app } = require("electron");'
      printf 'require("child_process").spawn("%s", [], { detached: true, stdio: "ignore" }).unref();\n' "$PREFIX/nitrosense"
      echo 'app.exit(0);'
    } >"$APP_DIR/main.js"
  fi
  if [ -d "$PREFIX/acer.keep" ]; then
    if [ -d "$APP_DIR/assets/acer" ]; then
      rm -rf "$PREFIX/acer.keep"
    else
      mkdir -p "$APP_DIR/assets"
      mv "$PREFIX/acer.keep" "$APP_DIR/assets/acer"
    fi
  fi
fi

# ---------- NitroSense artwork ----------

assets_complete() { artwork_complete "$APP_DIR/assets/acer"; }
extract_assets() { artwork_extract "$1" "$APP_DIR/assets/acer"; }

if [ -n "$ASSETS_SOURCE" ]; then
  say "Copying NitroSense artwork from $ASSETS_SOURCE"
  extract_assets "$ASSETS_SOURCE"
else
  # NitroSense on Windows (picked up during the root step, or on a mounted drive) is the newest version;
  # whatever it doesn't provide comes from Acer's package in the Microsoft Store.
  windows=""
  [ -n "$STAGE" ] && [ -f "$STAGE/app/resources/app.asar" ] && windows=$STAGE
  [ -n "$windows" ] || windows=$(artwork_find /run/media/"$USER"/* /media/"$USER"/* /mnt /mnt/*)
  if [ -n "$windows" ]; then
    say "Copying NitroSense artwork from Windows"
    extract_assets "$windows" >/dev/null || true
  fi
  if assets_complete; then
    say "NitroSense artwork is in place"
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
rm -f "$BIN/nitrosense"
if [ "$DEV" -eq 1 ]; then
  printf '#!/bin/sh\n# Development: the build in the checkout, reloading the window when files in app/ change.\nexec "%s" --dev "$@"\n' "$BUILT/nitrosense" >"$BIN/nitrosense"
  chmod +x "$BIN/nitrosense"
else
  ln -s "$PREFIX/nitrosense" "$BIN/nitrosense"
fi
install -m644 "$REPO/data/nitrosense.desktop" "$APPS/nitrosense.desktop"
# Like NitroSense, it starts hidden at login so App Sync and the mode-change flash keep working.
mkdir -p "$AUTOSTART"
printf '[Desktop Entry]\nType=Application\nName=NitroSense\nExec=%s --hidden\nNoDisplay=true\n' "$BIN/nitrosense" >"$AUTOSTART/nitrosense.desktop"

key_bind

# A copy that was running in the background keeps doing so, now as the new version.
if [ "$WAS_RUNNING" -eq 1 ]; then
  setsid "$BIN/nitrosense" --hidden >/dev/null 2>&1 </dev/null &
fi

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
