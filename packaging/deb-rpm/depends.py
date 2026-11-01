"""Print the .deb and .rpm dependencies of nitrosense-linux: two JSON lists, the .deb's first.

usage: depends.py ELECTRON_DIR

They're the libraries the bundled Electron loads but doesn't bring itself (read from its ELF files), plus the app's
own needs. The .rpm names the libraries themselves, as rpmbuild would; the .deb needs each one's Debian package in DEB
below, so a library Electron starts to load makes this fail until it's added there.
"""
import json
import os
import re
import subprocess
import sys

# soname -> Debian/Ubuntu package. "new | old": Debian 13 and Ubuntu 24.04 renamed these for 64-bit time_t.
DEB = {
    "ld-linux-x86-64.so.2": "libc6",
    "libc.so.6": "libc6",
    "libdl.so.2": "libc6",
    "libm.so.6": "libc6",
    "libpthread.so.0": "libc6",
    "libgcc_s.so.1": "libgcc-s1",
    "libasound.so.2": "libasound2t64 | libasound2",
    "libatk-1.0.so.0": "libatk1.0-0t64 | libatk1.0-0",
    "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0t64 | libatk-bridge2.0-0",
    "libatspi.so.0": "libatspi2.0-0t64 | libatspi2.0-0",
    "libcairo.so.2": "libcairo2",
    "libcups.so.2": "libcups2t64 | libcups2",
    "libdbus-1.so.3": "libdbus-1-3",
    "libexpat.so.1": "libexpat1",
    "libgbm.so.1": "libgbm1",
    "libgio-2.0.so.0": "libglib2.0-0t64 | libglib2.0-0",
    "libglib-2.0.so.0": "libglib2.0-0t64 | libglib2.0-0",
    "libgobject-2.0.so.0": "libglib2.0-0t64 | libglib2.0-0",
    "libgtk-3.so.0": "libgtk-3-0t64 | libgtk-3-0",
    "libnspr4.so": "libnspr4",
    "libnss3.so": "libnss3",
    "libnssutil3.so": "libnss3",
    "libsmime3.so": "libnss3",
    "libpango-1.0.so.0": "libpango-1.0-0",
    "libudev.so.1": "libudev1",
    "libX11.so.6": "libx11-6",
    "libxcb.so.1": "libxcb1",
    "libXcomposite.so.1": "libxcomposite1",
    "libXdamage.so.1": "libxdamage1",
    "libXext.so.6": "libxext6",
    "libXfixes.so.3": "libxfixes3",
    "libxkbcommon.so.0": "libxkbcommon0",
    "libXrandr.so.2": "libxrandr2",
}
# The app's own: the keyboard lighting writer (backend/enek-write.py) and the artwork tools run on Python.
APP = ["python3"]


def needed(path):
    dynamic = subprocess.run(["readelf", "-d", path], capture_output=True, text=True, check=True).stdout
    return re.findall(r"Shared library: \[([^\]]+)\]", dynamic)


def main():
    root = sys.argv[1]
    bundled = set(os.listdir(root))
    libraries = set()
    for name in sorted(bundled):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            if handle.read(4) != b"\x7fELF":
                continue
        libraries.update(needed(path))
    libraries -= bundled
    unknown = sorted(libraries - DEB.keys())
    if unknown:
        sys.exit(f"no Debian package known for {', '.join(unknown)}: add it to DEB in {sys.argv[0]}")
    print(json.dumps(APP + sorted({DEB[library] for library in libraries})))
    print(json.dumps(APP + sorted(f"{library}()(64bit)" for library in libraries)))


if __name__ == "__main__":
    main()
