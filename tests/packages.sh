#!/usr/bin/env bash
# Installs the .deb or .rpm packages build.sh made into this system, a throwaway container (the Checks workflow's
# packages-install job), and checks them: the guard against the installer's driver, the files, the linuwu_sense group,
# Electron starting, Acer's artwork, the AppArmor profile, the driver built by DKMS against this distribution's kernel
# headers, a reinstall, and a removal that leaves nothing behind.
# Usage, as root: bash tests/packages.sh DIST   (NITROSENSE_ASSETS: Acer's NitroSense package, so the install doesn't
# download it from the Microsoft Store)
set -euo pipefail
dist=$(cd "${1:?usage: tests/packages.sh DIST}" && pwd)
lib=/usr/lib/nitrosense-linux
log=$(mktemp)
fail() {
  echo "--- package manager output (last lines)"
  tail -n 40 "$log"
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok   $*"; }

if command -v apt-get >/dev/null; then
  format=deb
  export DEBIAN_FRONTEND=noninteractive
  app=$(echo "$dist"/nitrosense-linux_*_amd64.deb)
  driver=$(echo "$dist"/linuwu-sense-gpu-mode-dkms_*_all.deb)
  driver_version=$(basename "$driver" | sed 's/^linuwu-sense-gpu-mode-dkms_\([^-]*\)-.*/\1/')
  add() { apt-get install -y -q "$@" >>"$log" 2>&1; }
  again() { apt-get install -y -q --reinstall "$@" >>"$log" 2>&1; }
  drop() { apt-get purge -y -q "$@" >>"$log" 2>&1; }
  owned() { dpkg -L "$1"; }
  claimed() { dpkg -S "$1" >/dev/null 2>&1; }
  contents() { dpkg-deb --fsys-tarfile "$1" | tar -t | sed 's#^\.##; s#/$##'; }
  apt-get update -q >>"$log" 2>&1
  # AppArmor first, so the app package can add its profile where the kernel restricts user namespaces. Then kernel
  # headers to build the driver against, as a desktop has them (a container has no kernel): Ubuntu's HWE kernel, its
  # desktop default (linuwu-sense needs Linux 6.14, newer than 24.04's original 6.8), else Debian's.
  apt-get install -y -q apparmor >>"$log" 2>&1 || fail "installing apparmor failed"
  . /etc/os-release
  apt-get install -y -q "linux-headers-generic-hwe-$VERSION_ID" >>"$log" 2>&1 ||
    apt-get install -y -q linux-headers-generic >>"$log" 2>&1 ||
    apt-get install -y -q linux-headers-amd64 >>"$log" 2>&1 || fail "installing kernel headers failed"
  # Debian's own kernel (13: 6.12) is too old for the driver, so DKMS skips it; its backports kernel builds it.
  if [ "$ID" = debian ]; then
    echo "deb http://deb.debian.org/debian $VERSION_CODENAME-backports main" >/etc/apt/sources.list.d/backports.list
    { apt-get update -q && apt-get install -y -q -t "$VERSION_CODENAME-backports" linux-headers-amd64; } >>"$log" 2>&1 ||
      fail "installing the backports kernel headers failed"
  fi
else
  format=rpm
  app=$(echo "$dist"/nitrosense-linux-*.x86_64.rpm)
  driver=$(echo "$dist"/linuwu-sense-gpu-mode-dkms-*.noarch.rpm)
  driver_version=$(basename "$driver" | sed 's/^linuwu-sense-gpu-mode-dkms-\([^-]*\)-.*/\1/')
  add() { dnf install -y -q --setopt=install_weak_deps=False "$@" >>"$log" 2>&1; }
  again() { dnf reinstall -y -q "$@" >>"$log" 2>&1; }
  drop() { dnf remove -y -q "$@" >>"$log" 2>&1; }
  owned() { rpm -ql "$1"; }
  claimed() { rpm -qf "$1" >/dev/null 2>&1; }
  contents() { rpm -qlp "$1"; }
  # A container has no kernel: kernel-devel brings headers to build the driver against.
  dnf install -y -q --setopt=install_weak_deps=False kernel-devel >>"$log" 2>&1 || fail "installing kernel-devel failed"
fi

# ---------- the installer's driver ----------

mkdir -p /usr/src/linuwu-sense-1.0.0
echo '  MAKE[0]="make -C $kernel_source_dir M=$dkms_tree/$PACKAGE_NAME/$PACKAGE_VERSION/build modules"' \
  >/usr/src/linuwu-sense-1.0.0/dkms.conf
if add "$driver"; then fail "the driver package installed next to the installer's driver"; fi
grep -q "installer already built linuwu-sense" "$log" || fail "no explanation when the installer's driver is there"
rm -r /usr/src/linuwu-sense-1.0.0
pass "the driver package stops while the installer's driver is there"

# ---------- install ----------

# The folders the packages' files go into that aren't here yet: the removal at the end has to take them away again.
made=$(
  { contents "$app"; contents "$driver"; } | while IFS= read -r path; do
    path=${path%/*}
    while [ -n "$path" ] && [ ! -e "$path" ]; do
      echo "$path"
      path=${path%/*}
    done
  done | sort -u
) || fail "listing the packages' files failed"
add "$app" "$driver" || fail "installing the packages failed"
pass "installed $(basename "$app") and $(basename "$driver")"

for file in /usr/bin/nitrosense /usr/bin/nitrosense-setup /usr/bin/nitrosense-artwork "$lib/app/main.js" \
    "$lib/electron/electron" /usr/share/applications/nitrosense.desktop /etc/xdg/autostart/nitrosense.desktop \
    /usr/lib/udev/rules.d/70-nitrosense.rules /usr/lib/sysusers.d/nitrosense-linux.conf \
    "/usr/src/linuwu-sense-$driver_version/dkms.conf" /usr/lib/systemd/system/linuwu_sense.service \
    /usr/lib/modprobe.d/linuwu-sense-gpu-mode-dkms.conf; do
  [ -e "$file" ] || fail "$file is missing"
done
[ "$(cat "$lib/app/packaged")" = "$format" ] || fail "app/packaged isn't \"$format\""
getent group linuwu_sense >/dev/null || fail "there's no linuwu_sense group"
if owned nitrosense-linux | grep -q '/assets/acer/'; then fail "the package itself holds Acer's artwork"; fi
pass "files, the packaged marker and the linuwu_sense group"

# The Mode Switch Key service: the unit runs the packaged service, and udev starts it for the keyboards in the rule.
unit=/usr/lib/systemd/system/nitrosense-modekey@.service
grep -qx "ExecStart=/usr/bin/python3 -I -B $lib/nitrosense-modekey /dev/%I" "$unit" ||
  fail "the Mode Switch Key unit doesn't run $lib/nitrosense-modekey"
[ -x "$lib/nitrosense-modekey" ] || fail "the Mode Switch Key service isn't executable"
python3 -I -B -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$lib/nitrosense-modekey" ||
  fail "the Mode Switch Key service doesn't parse with this distribution's Python"
grep -q 'nitrosense-modekey@%k.service' /usr/lib/udev/rules.d/70-nitrosense.rules ||
  fail "udev doesn't start the Mode Switch Key service"
pass "the Mode Switch Key service, its unit and its udev rule"

# Containers block the user namespaces Chromium's sandbox needs (Docker's seccomp filter), hence --no-sandbox here;
# Electron still loads every library it needs when it starts.
version=$("$lib/electron/electron" --no-sandbox --version 2>>"$log") || fail "Electron doesn't start"
pass "Electron $version starts: every library it loads is installed"

[ "$(readlink "$lib/app/assets/acer")" = /var/lib/nitrosense-linux/acer ] ||
  fail "app/assets/acer doesn't point at /var/lib/nitrosense-linux/acer"
missing=0
while IFS=$'\t' read -r target _; do
  [[ -z $target || $target == \#* ]] && continue
  [ -f "$lib/app/assets/acer/$target" ] || missing=$((missing + 1))
done <"$lib/data/acer-assets.tsv"
[ "$missing" -eq 0 ] || fail "$missing artwork files are missing"
env -u NITROSENSE_ASSETS nitrosense-artwork | grep -q 'in place' || fail "nitrosense-artwork doesn't find the artwork complete"
pass "Acer's artwork is complete, and nitrosense-artwork sees that without downloading"

if [ "$format" = deb ]; then
  apparmor_parser -Q -K "$lib/apparmor-profile" || fail "this distribution's AppArmor can't read the profile"
  if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    [ -f /etc/apparmor.d/nitrosense-linux ] || fail "no AppArmor profile although the kernel restricts user namespaces"
    pass "the AppArmor profile parses and is in /etc/apparmor.d"
  else
    pass "the AppArmor profile parses (this kernel doesn't restrict user namespaces, so it isn't installed)"
  fi
fi

# ---------- the driver ----------

dkms status -m linuwu-sense -v "$driver_version" | grep -q . || fail "linuwu-sense $driver_version isn't in DKMS"
# DKMS skips kernels older than dkms.conf's BUILD_EXCLUSIVE_KERNEL_MIN instead of failing on them.
min_kernel=$(sed -n 's/^BUILD_EXCLUSIVE_KERNEL_MIN="\(.*\)"$/\1/p' "/usr/src/linuwu-sense-$driver_version/dkms.conf")
[ -n "$min_kernel" ] || fail "dkms.conf names no minimum kernel"
kernels=""
built=0
for build in /lib/modules/*/build /usr/src/kernels/*; do
  [ -d "$build" ] || continue
  case "$build" in
    /lib/modules/*) kernel=${build#/lib/modules/}; kernel=${kernel%/build} ;;
    *) kernel=${build#/usr/src/kernels/} ;;
  esac
  case " $kernels " in *" $kernel "*) continue ;; esac
  kernels="$kernels $kernel"
  if [ "$(printf '%s\n' "$min_kernel" "$kernel" | sort -V | head -n1)" != "$min_kernel" ]; then
    if dkms status -m linuwu-sense -v "$driver_version" -k "$kernel" | grep -q installed; then
      fail "linuwu-sense was built for $kernel, older than $min_kernel"
    fi
    pass "linuwu-sense is skipped for kernel $kernel (older than $min_kernel)"
    continue
  fi
  if ! dkms status -m linuwu-sense -v "$driver_version" -k "$kernel" | grep -q installed; then
    # Only Fedora's kernel-devel without its kernel lacks the /lib/modules link the package builds through.
    [ "$format" = rpm ] && [ ! -e "/lib/modules/$kernel/build" ] || fail "the package didn't build linuwu-sense for $kernel"
    dkms build -m linuwu-sense -v "$driver_version" -k "$kernel" --kernelsourcedir "/usr/src/kernels/$kernel" >>"$log" 2>&1 || {
      cat "/var/lib/dkms/linuwu-sense/$driver_version/build/make.log" >>"$log" 2>/dev/null
      fail "linuwu-sense doesn't build for $kernel"
    }
  fi
  built=$((built + 1))
  pass "linuwu-sense $driver_version builds for kernel $kernel"
done
[ -n "$kernels" ] || fail "no kernel headers came along to build the driver against"
[ "$built" -gt 0 ] || fail "no kernel here is new enough ($min_kernel) to build linuwu-sense"

# ---------- reinstall and remove ----------

again "$app" "$driver" || fail "reinstalling the packages failed"
dkms status -m linuwu-sense -v "$driver_version" | grep -q . || fail "a reinstall took linuwu-sense out of DKMS"
[ -f "$lib/app/assets/acer/$(sed -n '/^[^#]/{s/\t.*//p;q}' "$lib/data/acer-assets.tsv")" ] || fail "a reinstall lost the artwork"
pass "a reinstall keeps the driver in DKMS and the artwork"

drop nitrosense-linux linuwu-sense-gpu-mode-dkms || fail "removing the packages failed"
for path in /var/lib/nitrosense-linux /etc/apparmor.d/nitrosense-linux /etc/nitrosense "$lib" "$unit" \
    "/usr/src/linuwu-sense-$driver_version" /usr/lib/linuwu-sense-gpu-mode-dkms; do
  [ ! -e "$path" ] || fail "$path is left behind"
done
# rpm removes only the folders a package lists, dpkg every one it made. An empty folder the install made may stay only
# when a package that's still installed (a dependency) owns it.
while IFS= read -r dir; do
  if [ -d "$dir" ] && [ -z "$(ls -A "$dir")" ] && ! claimed "$dir"; then fail "$dir is left behind"; fi
done <<<"$made"
[ -z "$(dkms status -m linuwu-sense 2>/dev/null)" ] || fail "linuwu-sense is still in DKMS"
pass "removing them leaves nothing behind"
echo "all passed"
