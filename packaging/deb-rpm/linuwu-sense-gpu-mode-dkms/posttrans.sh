#!/bin/sh
# .rpm: after the whole transaction, so an upgrade adds the new version once the old one has left DKMS.
/usr/lib/linuwu-sense-gpu-mode-dkms/hook install
exit 0
