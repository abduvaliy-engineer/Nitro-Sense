#!/bin/sh
# Before linuwu-sense-gpu-mode-dkms is installed or upgraded (.deb preinst, .rpm %pre). NitroSense's installer builds
# the same module into /usr/src/linuwu-sense-1.0.0, and two DKMS copies of one module conflict, so that build has to go
# first. It's recognised the way install.sh recognises its own builds (driver_outdated).
src=/usr/src/linuwu-sense-1.0.0
if [ -f "$src/.nitrosense-commit" ] ||
  grep -qF 'M=$dkms_tree/$PACKAGE_NAME/$PACKAGE_VERSION/build modules' "$src/dkms.conf" 2>/dev/null; then
  cat >&2 <<EOF
!! linuwu-sense-gpu-mode-dkms: NitroSense's installer already built linuwu-sense in $src.
   Remove that copy first, then install this package again:
     ./install.sh --uninstall    (in your Nitro-Sense folder, to move the app to the package as well)
     sudo dkms remove linuwu-sense/1.0.0 --all && sudo rm -rf $src
EOF
  exit 1
fi
exit 0
