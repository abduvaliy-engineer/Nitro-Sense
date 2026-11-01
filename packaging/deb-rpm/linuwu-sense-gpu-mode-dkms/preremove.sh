#!/bin/sh
# Before linuwu-sense-gpu-mode-dkms is removed (.deb "remove", .rpm 0) or replaced by another version (.deb "upgrade",
# .rpm 1): this version leaves DKMS, and an upgrade adds the new one after it.
case "$1" in
  remove|0) /usr/lib/linuwu-sense-gpu-mode-dkms/hook uninstall ;;
  upgrade|deconfigure|failed-upgrade|1) /usr/lib/linuwu-sense-gpu-mode-dkms/hook remove ;;
esac
exit 0
