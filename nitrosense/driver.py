"""Direct access to the linuwu-sense driver (sysfs) and the ENEK5130 keyboard (hidraw)."""

import fcntl
import os
from pathlib import Path

ACER_WMI = Path("/sys/devices/platform/acer-wmi")
FOUR_ZONE_KB = Path("/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb")
PLATFORM_PROFILE = Path("/sys/firmware/acpi/platform_profile")
PLATFORM_PROFILE_CHOICES = Path("/sys/firmware/acpi/platform_profile_choices")
HIDRAW_CLASS = Path("/sys/class/hidraw")
ENEK5130_ID = "0CF2:5130"

FLAGS = ("backlight_timeout", "battery_calibration", "battery_limiter", "boot_animation_sound", "lcd_override")

# UI effect index -> ENEK5130 effect byte (0 = static, handled separately).
ENEK_EFFECTS = {1: 0x04, 2: 0x05, 3: 0x07, 4: 0x07, 5: 0x09, 6: 0x0A, 7: 0x0B}
ENEK_STATIC = 0x02
ZONE_MASKS = (0x01, 0x02, 0x04, 0x08)
ALL_ZONES = 0x0F


def _hidiocsfeature(length):
    # _IOC(_IOC_READ | _IOC_WRITE, 'H', 0x06, length)
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x06


class DriverError(RuntimeError):
    pass


def _permission_hint(path):
    return f"No write access to {path}. Run ./install.sh once to grant the linuwu_sense group access."


class Driver:
    def __init__(self):
        self.sense_dir = next(
            (ACER_WMI / name for name in ("nitro_sense", "predator_sense") if (ACER_WMI / name).is_dir()),
            None,
        )

    # ---------- io ----------

    @staticmethod
    def _read(path):
        try:
            return path.read_text().strip()
        except OSError:
            return None

    @staticmethod
    def _write(path, value):
        try:
            with open(path, "w") as stream:
                stream.write(f"{value}\n")
        except PermissionError as exc:
            raise DriverError(_permission_hint(path)) from exc
        except OSError as exc:
            raise DriverError(f"Driver rejected {path.name}={value}: {exc.strerror}") from exc

    def _attr(self, name):
        return self.sense_dir / name if self.sense_dir else None

    def _enek_device(self):
        for node in sorted(HIDRAW_CLASS.glob("hidraw*")):
            uevent = self._read(node / "device" / "uevent") or ""
            if ENEK5130_ID in uevent.upper():
                return Path("/dev") / node.name
        return None

    # ---------- state ----------

    def features(self):
        found = set()
        if PLATFORM_PROFILE.exists():
            found.add("thermal_profile")
        for name in FLAGS + ("fan_speed", "usb_charging"):
            attr = self._attr(name)
            if attr is not None and attr.exists():
                found.add(name)
        if self._enek_device() or (FOUR_ZONE_KB / "four_zone_mode").exists():
            found.add("four_zone_mode")
        if self._enek_device() or (FOUR_ZONE_KB / "per_zone_mode").exists():
            found.add("per_zone_mode")
        return found

    def live(self):
        """Cheap values that are safe to poll often (no WMI calls, no kernel log noise)."""
        fan = (self._read(self._attr("fan_speed")) or "0,0") if self.sense_dir else "0,0"
        cpu, _, gpu = fan.partition(",")
        return {
            "thermal_profile": {
                "current": self._read(PLATFORM_PROFILE) or "",
                "available": (self._read(PLATFORM_PROFILE_CHOICES) or "").split(),
            },
            "fan_speed": {"cpu": cpu or "0", "gpu": gpu or "0"},
        }

    def settings(self):
        features = self.features()
        settings = self.live()
        settings["available_features"] = sorted(features)
        settings["laptop_type"] = "PREDATOR" if self.sense_dir and self.sense_dir.name == "predator_sense" else "NITRO"
        settings["rgb_device"] = str(self._enek_device() or (FOUR_ZONE_KB if FOUR_ZONE_KB.exists() else ""))
        for name in FLAGS + ("usb_charging",):
            if name in features:
                settings[name] = self._read(self._attr(name))
        return settings

    # ---------- controls ----------

    def set_thermal_profile(self, profile):
        choices = (self._read(PLATFORM_PROFILE_CHOICES) or "").split()
        if profile not in choices:
            raise DriverError(f"Unsupported power mode: {profile}")
        self._write(PLATFORM_PROFILE, profile)

    def set_fan_speed(self, cpu, gpu):
        cpu, gpu = int(cpu), int(gpu)
        if not (0 <= cpu <= 100 and 0 <= gpu <= 100):
            raise DriverError("Fan speeds must be 0-100%")
        self._write(self._attr("fan_speed"), f"{cpu},{gpu}")

    def set_flag(self, name, enabled):
        if name not in FLAGS:
            raise DriverError(f"Unknown setting: {name}")
        self._write(self._attr(name), 1 if enabled else 0)

    def set_usb_charging(self, level):
        if int(level) not in (0, 10, 20, 30):
            raise DriverError("USB charging level must be 0, 10, 20 or 30")
        self._write(self._attr("usb_charging"), int(level))

    # ---------- keyboard lighting ----------

    def _enek_report(self, effect, brightness, speed, direction, red, green, blue, zone_mask):
        device = self._enek_device()
        if device is None:
            raise DriverError("ENEK5130 keyboard controller not found")
        packet = bytearray([0xA4, 0x21, effect, brightness, speed, direction, red, green, blue, zone_mask, 0x00])
        try:
            fd = os.open(device, os.O_RDWR | os.O_NONBLOCK)
        except PermissionError as exc:
            raise DriverError(_permission_hint(device)) from exc
        try:
            fcntl.ioctl(fd, _hidiocsfeature(len(packet)), packet, True)
        except OSError as exc:
            raise DriverError(f"Keyboard rejected the lighting command: {exc.strerror}") from exc
        finally:
            os.close(fd)

    def set_four_zone_mode(self, mode, speed, brightness, direction, red, green, blue):
        if self._enek_device():
            if mode == 0:
                self._enek_report(ENEK_STATIC, brightness, 0, 0, red, green, blue, ALL_ZONES)
            else:
                # Breathing/neon take the raw speed; the rest expect 1-10.
                effect = ENEK_EFFECTS[mode]
                hid_speed = speed if effect in (0x04, 0x05) else min(10, max(1, speed + 1))
                self._enek_report(effect, brightness, hid_speed, direction, red, green, blue, ALL_ZONES)
            return
        self._write(FOUR_ZONE_KB / "four_zone_mode",
                    f"{mode},{speed},{brightness},{direction},{red},{green},{blue}")

    def set_per_zone_mode(self, zones, brightness):
        if self._enek_device():
            for zone, mask in zip(zones, ZONE_MASKS):
                r, g, b = (int(zone[i:i + 2], 16) for i in (0, 2, 4))
                self._enek_report(ENEK_STATIC, brightness, 0, 0, r, g, b, mask)
            return
        self._write(FOUR_ZONE_KB / "per_zone_mode", ",".join(zones) + f",{brightness}")
