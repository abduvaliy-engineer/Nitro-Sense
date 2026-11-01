#!/bin/sh
# .deb: after linuwu-sense-gpu-mode-dkms is installed or upgraded ("configure"). The .rpm does this in posttrans.
case "$1" in configure) /usr/lib/linuwu-sense-gpu-mode-dkms/hook install ;; esac
exit 0
