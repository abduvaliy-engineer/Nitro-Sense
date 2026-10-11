from dataclasses import dataclass
from pathlib import Path

HWMON_ROOT = Path("/sys/class/hwmon")
DMI_ROOT = Path("/sys/class/dmi/id")


def _read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _read_int(path):
    value = _read(path)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _find_hwmon(name):
    for path in sorted(HWMON_ROOT.glob("hwmon*")):
        if _read(path / "name") == name:
            return path
    return None


@dataclass
class Reading:
    cpu_temp: float | None = None
    gpu_temp: float | None = None
    sys_temp: float | None = None
    cpu_rpm: int | None = None
    gpu_rpm: int | None = None


class Sensors:
    def __init__(self):
        self.acer = _find_hwmon("acer")
        self.k10temp = _find_hwmon("k10temp") or _find_hwmon("coretemp")

    def _temp(self, hwmon, index):
        if hwmon is None:
            return None
        value = _read_int(hwmon / f"temp{index}_input")
        # The EC reports 0 for sensors that are powered down (e.g. idle dGPU).
        return value / 1000 if value else None

    def read(self):
        reading = Reading()
        if self.acer is not None:
            reading.cpu_temp = self._temp(self.acer, 1)
            reading.gpu_temp = self._temp(self.acer, 2)
            reading.sys_temp = self._temp(self.acer, 3)
            reading.cpu_rpm = _read_int(self.acer / "fan1_input")
            reading.gpu_rpm = _read_int(self.acer / "fan2_input")
        if reading.cpu_temp is None:
            reading.cpu_temp = self._temp(self.k10temp, 1)
        return reading


def model_name():
    return _read(DMI_ROOT / "product_name") or "Acer laptop"


def bios_version():
    return _read(DMI_ROOT / "bios_version") or "unknown"
