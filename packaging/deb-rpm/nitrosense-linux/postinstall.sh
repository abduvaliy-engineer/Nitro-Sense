#!/bin/sh
# After nitrosense-linux is installed or upgraded (.deb: "configure", .rpm: 1 or 2): the parts that can't ship as
# files. Every step can run again on an upgrade.
case "$1" in configure|1|2) ;; *) exit 0 ;; esac
lib=/usr/lib/nitrosense-linux

# The linuwu_sense group may use the driver's controls and the keyboard lighting (70-nitrosense.rules), from now on
# rather than from the next boot.
if command -v systemd-sysusers >/dev/null 2>&1; then
  systemd-sysusers /usr/lib/sysusers.d/nitrosense-linux.conf
else
  getent group linuwu_sense >/dev/null || groupadd --system linuwu_sense
fi
# systemd learns the Mode Switch Key service's unit before the hidraw trigger below starts it; a running one
# restarts with the new version.
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl try-restart 'nitrosense-modekey@*.service' 2>/dev/null
fi
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload 2>/dev/null
  udevadm trigger --action=bind /sys/devices/platform/acer-wmi 2>/dev/null
  udevadm trigger --action=add --subsystem-match=platform-profile 2>/dev/null
  udevadm trigger --subsystem-match=hidraw --action=add 2>/dev/null
  if [ -d /sys/module/linuwu_sense ]; then udevadm trigger --action=add /sys/module/linuwu_sense 2>/dev/null; fi
fi

# The CPU's rated maximum clock (SMBIOS type 4, max speed at offset 0x14) for the Home gauges; only root can read it.
mhz=$(od -An -tu2 -j20 -N2 /sys/firmware/dmi/entries/4-0/raw 2>/dev/null | tr -d ' ')
if [ -n "$mhz" ] && [ "$mhz" -gt 0 ] 2>/dev/null; then
  mkdir -p /etc/nitrosense && echo "$mhz" >/etc/nitrosense/cpu_max_mhz
fi

# Ubuntu 24.04 and newer let only programs with an AppArmor profile create the user namespaces Chromium's sandbox
# needs. Older AppArmor can't read the profile, so it goes in only where the kernel has that restriction.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ -d /etc/apparmor.d ]; then
  cp "$lib/apparmor-profile" /etc/apparmor.d/nitrosense-linux
  chmod 644 /etc/apparmor.d/nitrosense-linux
  if command -v apparmor_parser >/dev/null 2>&1 && [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
    apparmor_parser -r -T -W /etc/apparmor.d/nitrosense-linux 2>/dev/null ||
      echo "!! NitroSense: its AppArmor profile couldn't be loaded now; it loads at the next boot." >&2
  fi
fi

# Acer's artwork (NITROSENSE_ASSETS: a NitroSense package to take it from instead of searching or downloading).
if ! /usr/bin/nitrosense-artwork; then
  echo "!! NitroSense: Acer's artwork couldn't be fetched. Get it later with: sudo nitrosense-artwork" >&2
fi

# The installer's own copy wins over the package for that user (its launcher, menu entry and autostart).
for home in /home/*; do
  if [ -d "$home/.local/share/nitrosense/app" ]; then
    echo "!! NitroSense: the installer's copy in $home/.local/share/nitrosense starts instead of this package;" \
      "remove it with ./install.sh --uninstall (as that user)." >&2
  fi
done

# First install: .deb "configure" without a previous version, .rpm 1.
if { [ "$1" = configure ] && [ -z "${2:-}" ]; } || [ "$1" = 1 ]; then
  cat <<'EOF'
==> NitroSense: run this once as each user who uses it, then log out and back in:
      nitrosense-setup
    It joins the linuwu_sense group (for the controls) and binds the NitroSense key on GNOME and Hyprland.
    GPU Operating needs the linuwu-sense-gpu-mode-dkms package.
EOF
fi
exit 0
