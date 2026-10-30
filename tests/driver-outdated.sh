#!/usr/bin/env bash
# install.sh's driver_outdated: which installed linuwu-sense trees the installer rebuilds.
# Usage: bash tests/driver-outdated.sh [install.sh]
set -euo pipefail
INSTALL=${1:-$(dirname "$0")/../install.sh}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
eval "$(grep -E '^LINUWU_COMMIT=' "$INSTALL")"
eval "$(sed -n '/^driver_outdated() {/,/^}/p' "$INSTALL")"
LINUWU_SRC=$work/linuwu-sense-1.0.0
fail() { echo "FAIL: $*"; exit 1; }
ours() { printf '  MAKE[0]="make -C $kernel_source_dir M=$dkms_tree/$PACKAGE_NAME/$PACKAGE_VERSION/build modules"\n'; }

driver_outdated && fail "no linuwu-sense tree: nothing to rebuild"

mkdir -p "$LINUWU_SRC"
printf 'PACKAGE_VERSION="1.0"\nMAKE[0]="'"'make'"' KVER=${kernelver}"\n' >"$LINUWU_SRC/dkms.conf"
driver_outdated && fail "a tree installed another way was taken for ours"

ours >"$LINUWU_SRC/dkms.conf"
driver_outdated || fail "our build from before commits were recorded was not rebuilt"

echo "$LINUWU_COMMIT" >"$LINUWU_SRC/.nitrosense-commit"
driver_outdated && fail "our build at the pinned commit was rebuilt"

echo 73a25ec243a44ba2b1703e8d0a76fa2735062506 >"$LINUWU_SRC/.nitrosense-commit"
driver_outdated || fail "our build at another commit was not rebuilt"

echo "all passed"
