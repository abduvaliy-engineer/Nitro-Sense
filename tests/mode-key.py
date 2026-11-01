#!/usr/bin/env python3
"""Mode Switch Key service checks (no keyboard, no sysfs): python3 -I -B tests/mode-key.py data/nitrosense-modekey"""
import importlib.machinery
import importlib.util
import os
import sys
import tempfile

path = sys.argv[1] if len(sys.argv) > 1 else "data/nitrosense-modekey"
loader = importlib.machinery.SourceFileLoader("modekey", path)
spec = importlib.util.spec_from_loader("modekey", loader)
assert spec is not None
modekey = importlib.util.module_from_spec(spec)
loader.exec_module(modekey)

failed = 0


def check(name, got, want):
    global failed
    ok = got == want
    failed += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f": got {got!r}, want {want!r}"))


ALL = ["low-power", "quiet", "balanced", "balanced-performance", "performance"]

check("the key's report", modekey.is_mode_key(b"\x04\x85\xff"), True)
check("report 4 with another code", modekey.is_mode_key(b"\x04\x86\xff"), False)
check("a keystroke report", modekey.is_mode_key(b"\x01\x00\x00\x04\x00\x00\x00\x00\x00"), False)
check("a short report", modekey.is_mode_key(b"\x04"), False)

cycle = []
mode = "quiet"
for _ in range(4):
    mode = modekey.next_mode(mode, "ac", ALL)
    cycle.append(mode)
check("on AC: Quiet > Balanced > Performance > Turbo > Quiet", cycle,
      ["balanced", "balanced-performance", "performance", "quiet"])
check("on AC, Eco goes to Quiet", modekey.next_mode("low-power", "ac", ALL), "quiet")
check("on AC, custom (drivers disagree) goes to Quiet", modekey.next_mode("custom", "ac", ALL), "quiet")
check("on battery: Balanced > Eco", modekey.next_mode("balanced", "battery", ALL), "low-power")
check("on battery: Eco > Balanced", modekey.next_mode("low-power", "battery", ALL), "balanced")
check("on battery, Turbo goes to Balanced", modekey.next_mode("performance", "battery", ALL), "balanced")
check("low-battery lock: Quiet > Balanced", modekey.next_mode("quiet", "locked", ALL), "balanced")
check("low-battery lock: Balanced > Quiet", modekey.next_mode("balanced", "locked", ALL), "quiet")
check("low-battery lock, Turbo goes to Quiet", modekey.next_mode("performance", "locked", ALL), "quiet")
check("only the driver's choices", modekey.next_mode("balanced", "ac", ["low-power", "balanced", "performance"]),
      "performance")
check("no choices", modekey.next_mode("balanced", "ac", []), None)


def supplies(**entries):
    root = tempfile.mkdtemp()
    for name, values in entries.items():
        os.makedirs(os.path.join(root, name))
        for key, value in values.items():
            with open(os.path.join(root, name, key), "w") as f:
                f.write(f"{value}\n")
    return root


usb = {"type": "USB", "online": "0"}
check("AC plugged in", modekey.power_state(supplies(ACAD={"type": "Mains", "online": 1},
                                                    BAT1={"type": "Battery", "capacity": 80}, usbc=usb)), "ac")
check("on battery", modekey.power_state(supplies(ACAD={"type": "Mains", "online": 0},
                                                 BAT1={"type": "Battery", "capacity": 80}, usbc=usb)), "battery")
check("AC below 40 %", modekey.power_state(supplies(ACAD={"type": "Mains", "online": 1},
                                                    BAT1={"type": "Battery", "capacity": 39})), "locked")
check("AC at 40 %", modekey.power_state(supplies(ACAD={"type": "Mains", "online": 1},
                                                 BAT1={"type": "Battery", "capacity": 40})), "ac")
check("no readable battery", modekey.power_state(supplies(ACAD={"type": "Mains", "online": 1},
                                                          BAT1={"type": "Battery"})), "ac")

print(f"{failed} FAILED" if failed else "all passed")
sys.exit(1 if failed else 0)
