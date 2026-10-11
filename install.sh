#!/bin/sh
# Installs NitroSense for the current user and grants the linuwu_sense group driver access.
set -e
cd "$(dirname "$0")"

pkexec sh -c "install -m644 '$PWD/data/70-nitrosense.rules' /etc/udev/rules.d/70-nitrosense.rules \
  && udevadm control --reload \
  && udevadm trigger --action=bind /sys/devices/platform/acer-wmi \
  && udevadm trigger --subsystem-match=hidraw --action=add"

mkdir -p ~/.local/bin ~/.local/share/applications
cat > ~/.local/bin/nitrosense <<LAUNCHER
#!/bin/sh
cd '$PWD' && exec python3 -m nitrosense "\$@"
LAUNCHER
chmod +x ~/.local/bin/nitrosense
install -m644 data/nitrosense.desktop ~/.local/share/applications/nitrosense.desktop

id -nG | grep -qw linuwu_sense || echo "Add yourself to the linuwu_sense group and log in again: sudo usermod -aG linuwu_sense $USER"
echo "Installed. Launch NitroSense from your app launcher or run: nitrosense"
