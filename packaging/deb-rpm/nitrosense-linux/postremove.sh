#!/bin/sh
# After nitrosense-linux is removed (.deb: "remove", then "purge"; .rpm: 0). An upgrade (.deb "upgrade", .rpm 1)
# keeps everything.
case "$1" in remove|purge|0) ;; *) exit 0 ;; esac

if [ -e /etc/apparmor.d/nitrosense-linux ]; then
  if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser -R /etc/apparmor.d/nitrosense-linux 2>/dev/null; fi
  rm -f /etc/apparmor.d/nitrosense-linux
fi
rm -f /etc/nitrosense/cpu_max_mhz
rmdir /etc/nitrosense 2>/dev/null

# Acer's artwork goes with the package on the .rpm, and on purge (apt purge) on the .deb.
case "$1" in purge|0) rm -rf /var/lib/nitrosense-linux ;; esac

if [ "$1" != purge ]; then
  cat <<'EOF'
==> A NitroSense key binding nitrosense-setup added stays in your desktop settings: the XF86Presentation line in
    your Hyprland config, or the NitroSense custom shortcut in GNOME Settings.
EOF
fi
exit 0
