#!/usr/bin/env bash
# Builds the .deb and .rpm packages of NitroSense for Linux (nitrosense-linux) and of its driver
# (linuwu-sense-gpu-mode-dkms), plus SHA256SUMS, from this checkout's files. The Checks and Release workflows run it;
# it needs an x86_64 Linux with curl, unzip (or bsdtar), readelf and python3.
#   bash packaging/deb-rpm/build.sh [OUT]   (OUT: the folder for the packages, default dist)
# Downloads, each checked against its sha256 and kept in $NS_BUILD_CACHE (default ~/.cache/nitrosense-build): nfpm,
# the Electron build install.sh pins, and the linuwu-sense source the AUR driver package pins.
set -euo pipefail

NFPM_VERSION=2.48.0
NFPM_SHA256=6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=${1:-dist}
cache=${NS_BUILD_CACHE:-$HOME/.cache/nitrosense-build}
die() { echo "build.sh: $*" >&2; exit 1; }

# The value of a shell assignment (NAME=value or NAME='value') in FILE.
value() { sed -n "s/^$2=['\"]\{0,1\}\([^'\" ]*\).*/\1/p" "$1" | head -n1; }
app_version=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/app/package.json")
electron_version=$(value "$repo/install.sh" ELECTRON_VERSION)
electron_sha256=$(value "$repo/install.sh" ELECTRON_SHA256)
driver_pkgbuild=$repo/packaging/aur/linuwu-sense-gpu-mode-dkms/PKGBUILD
driver_version=$(value "$driver_pkgbuild" pkgver)
driver_commit=$(value "$driver_pkgbuild" _commit)
driver_sha256=$(sed -n "s/^sha256sums=('\([0-9a-f]\{64\}\)')/\1/p" "$driver_pkgbuild")
for name in app_version electron_version electron_sha256 driver_version driver_commit driver_sha256; do
  [ -n "${!name}" ] || die "couldn't read $name"
done

# fetch URL NAME SHA256: downloads into the cache once, and checks the file every time.
mkdir -p "$cache"
fetch() {
  local file=$cache/$2
  if [ ! -s "$file" ]; then
    curl -fsSL --retry 3 -o "$file.part" "$1"
    mv "$file.part" "$file"
  fi
  echo "$3  $file" | sha256sum -c --quiet - >/dev/null 2>&1 || { rm -f "$file"; die "$2 doesn't match its sha256"; }
}
fetch "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz" \
  "nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz" "$NFPM_SHA256"
fetch "https://github.com/electron/electron/releases/download/v$electron_version/electron-v$electron_version-linux-x64.zip" \
  "electron-v$electron_version-linux-x64.zip" "$electron_sha256"
fetch "https://github.com/abduvaliy-engineer/Linuwu-Sense/archive/$driver_commit.tar.gz" \
  "linuwu-sense-$driver_commit.tar.gz" "$driver_sha256"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$cache/nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz" -C "$work" nfpm
nfpm=$work/nfpm

# This checkout's files except what git ignores, so Acer's artwork in a working copy (app/assets/acer) never gets
# into a package.
src=$work/src
while IFS= read -r -d '' file; do
  [ -f "$repo/$file" ] || continue
  install -D -m "$(stat -c %a "$repo/$file")" "$repo/$file" "$src/$file"
done < <(git -C "$repo" ls-files -z --cached --others --exclude-standard -- app data tools LICENSE)
[ ! -e "$src/app/assets/acer" ] || die "Acer's artwork must not go into a package"

# ---------- nitrosense-linux ----------

stage=$work/nitrosense-linux
lib=$stage/lib
mkdir -p "$lib/electron"
cp -a "$src/app" "$lib/app"
if command -v unzip >/dev/null; then
  unzip -q "$cache/electron-v$electron_version-linux-x64.zip" -d "$lib/electron"
else
  bsdtar -xf "$cache/electron-v$electron_version-linux-x64.zip" -C "$lib/electron"
fi
[ "$(cat "$lib/electron/version")" = "$electron_version" ] || die "the Electron build isn't $electron_version"
# Electron's zip has some files group-writable.
chmod -R go-w "$lib/electron"
# What nitrosense-artwork runs, in the layout it expects (NS_ROOT), and the AppArmor profile postinstall.sh installs.
install -Dm644 -t "$lib/tools" "$src/tools/extract-acer-assets.py" "$src/tools/fetch-nitrosense.py"
install -Dm644 -t "$lib/data" "$src/data/acer-assets.tsv" "$src/data/microsoft-root-2011.pem"
install -m644 "$here/nitrosense-linux/apparmor" "$lib/apparmor-profile"
# The Mode Switch Key service and its unit, which udev starts for keyboards that report the key.
install -m755 "$src/data/nitrosense-modekey" "$lib/nitrosense-modekey"
sed "s|@MODEKEY@|/usr/lib/nitrosense-linux/nitrosense-modekey|" "$src/data/nitrosense-modekey@.service" \
  >"$stage/nitrosense-modekey@.service"
printf '#!/bin/sh\nexec /usr/lib/nitrosense-linux/electron/electron /usr/lib/nitrosense-linux/app "$@"\n' \
  >"$stage/nitrosense"
chmod 755 "$stage/nitrosense"
echo deb >"$stage/packaged.deb"
echo rpm >"$stage/packaged.rpm"
printf '[Desktop Entry]\nType=Application\nName=NitroSense\nExec=nitrosense --hidden\nNoDisplay=true\n' \
  >"$stage/autostart.desktop"
echo 'g linuwu_sense - -' >"$stage/sysusers.conf"
depends=$(python3 -I "$here/depends.py" "$lib/electron")
deb_depends=$(sed -n 1p <<<"$depends")
rpm_depends=$(sed -n 2p <<<"$depends")

# ---------- linuwu-sense-gpu-mode-dkms ----------

driver=$work/linuwu-sense-gpu-mode-dkms
tar -xzf "$cache/linuwu-sense-$driver_commit.tar.gz" -C "$work"
tree=$work/Linuwu-Sense-$driver_commit
install -Dm644 "$tree/src/linuwu_sense.c" "$driver/src/src/linuwu_sense.c"
# Like the AUR package and install.sh: recent kernels reject these fortified strncpy calls; the copies are
# length-bounded anyway.
sed -i 's/\bstrncpy(/memcpy(/g' "$driver/src/src/linuwu_sense.c"
echo 'obj-m := src/linuwu_sense.o' >"$driver/src/Makefile"
# The driver uses the platform_profile API of Linux 6.14 (platform_profile_ops, devm_platform_profile_register):
# DKMS skips older kernels instead of failing on them.
cat >"$driver/src/dkms.conf" <<EOF
PACKAGE_NAME="linuwu-sense"
PACKAGE_VERSION="$driver_version"
BUILT_MODULE_NAME[0]="linuwu_sense"
BUILT_MODULE_LOCATION[0]="src"
DEST_MODULE_LOCATION[0]="/kernel/drivers/platform/x86"
MAKE[0]="make -C \$kernel_source_dir M=\$dkms_tree/\$PACKAGE_NAME/\$PACKAGE_VERSION/build modules"
AUTOINSTALL="yes"
BUILD_EXCLUSIVE_KERNEL_MIN="6.14"
EOF
sed "s/@DRIVER_VERSION@/$driver_version/" "$here/linuwu-sense-gpu-mode-dkms/hook" >"$driver/hook"
chmod 755 "$driver/hook"
echo 'blacklist acer_wmi' >"$driver/blacklist.conf"
echo 'linuwu_sense' >"$driver/modules-load.conf"
install -m644 "$tree/linuwu_sense.service" "$driver/linuwu_sense.service"
install -m644 "$tree/LICENSE" "$driver/LICENSE"

# ---------- packages ----------

# render PACKAGE STAGE: the package's nfpm.yaml with this build's values.
render() {
  sed -e "s|@APP_VERSION@|$app_version|g" -e "s|@DRIVER_VERSION@|$driver_version|g" -e "s|@STAGE@|$2|g" \
    -e "s|@SRC@|$src|g" -e "s|@HERE@|$here/$1|g" \
    -e "s#\[\"@DEB_DEPENDS@\"\]#$deb_depends#" -e "s#\[\"@RPM_DEPENDS@\"\]#$rpm_depends#" \
    "$here/$1/nfpm.yaml" >"$work/$1.yaml"
}
render nitrosense-linux "$stage"
render linuwu-sense-gpu-mode-dkms "$driver"

mkdir -p "$out"
out=$(cd "$out" && pwd)
rm -f "$out"/*.deb "$out"/*.rpm "$out"/SHA256SUMS
for package in nitrosense-linux linuwu-sense-gpu-mode-dkms; do
  for format in deb rpm; do
    "$nfpm" package --config "$work/$package.yaml" --packager "$format" --target "$out/"
  done
done
(cd "$out" && sha256sum -- *.deb *.rpm >SHA256SUMS)
