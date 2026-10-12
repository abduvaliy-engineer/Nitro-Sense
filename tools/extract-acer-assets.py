"""Copy the NitroSense artwork the app uses out of Acer's own NitroSense package.

usage: extract-acer-assets.py SOURCE MANIFEST DEST

SOURCE is NitroSense's app.asar, its installed package folder (WindowsApps/...NitroSense...), or a downloaded
.msix/.appx/.msixbundle/.appxbundle. MANIFEST is data/acer-assets.tsv; every file is checked against its sha256.
"""
import hashlib
import io
import json
import os
import struct
import sys
import zipfile

ASAR_IN_PACKAGE = "app/resources/app.asar"


def read_asar(data, unpacked):
    """Return a path -> bytes (or None) getter for an asar archive held in memory. Large files live next
    to it in app.asar.unpacked; unpacked(path) reads those."""
    header_size = struct.unpack_from("<I", data, 4)[0]
    json_size = struct.unpack_from("<I", data, 12)[0]
    header = json.loads(data[16:16 + json_size])
    base = 8 + header_size

    def get(path):
        node = header
        for part in path.split("/"):
            node = node.get("files", {}).get(part)
            if node is None:
                return None
        if node.get("unpacked"):
            return unpacked(path)
        if "offset" not in node:
            return None
        start = base + int(node["offset"])
        return data[start:start + node["size"]]

    return get


def asar_from_zip(blob):
    # Left open: unpacked files are read from it later.
    package = zipfile.ZipFile(io.BytesIO(blob))
    names = package.namelist()
    if ASAR_IN_PACKAGE in names:
        def unpacked(path):
            name = f"{ASAR_IN_PACKAGE}.unpacked/{path}"
            return package.read(name) if name in names else None
        return package.read(ASAR_IN_PACKAGE), unpacked
    # bundles hold one package per architecture; prefer x64
    inner = [name for name in names if name.lower().endswith((".msix", ".appx"))]
    for name in sorted(inner, key=lambda n: "x64" not in n.lower()):
        found = asar_from_zip(package.read(name))
        if found:
            return found
    return None


def load_asar(source):
    if os.path.isdir(source):
        source = os.path.join(source, ASAR_IN_PACKAGE)
    with open(source, "rb") as handle:
        blob = handle.read()
    if zipfile.is_zipfile(io.BytesIO(blob)):
        found = asar_from_zip(blob)
        if found is None:
            sys.exit("no NitroSense app.asar inside this package")
        return found

    def unpacked(path):
        try:
            with open(os.path.join(f"{source}.unpacked", path), "rb") as handle:
                return handle.read()
        except OSError:
            return None
    return blob, unpacked


def main():
    source, manifest, dest = sys.argv[1:4]
    get = read_asar(*load_asar(source))
    entries = {}
    for line in open(manifest, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            target, inner, digest = line.rstrip("\n").split("\t")
            entries.setdefault(target, []).append((inner, digest))
    missing = []
    for target, choices in entries.items():
        path = os.path.join(dest, target)
        try:
            with open(path, "rb") as existing:
                have = hashlib.sha256(existing.read()).hexdigest()
        except OSError:
            have = None
        # Never replace a file with a worse choice (an older NitroSense's version of it).
        have_rank = next((rank for rank, (_, digest) in enumerate(choices) if digest == have), None)
        for rank, (inner, digest) in enumerate(choices):
            if have_rank is not None and have_rank <= rank:
                break
            content = get(inner)
            if content is not None and hashlib.sha256(content).hexdigest() == digest:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as out:
                    out.write(content)
                break
        else:
            if have_rank is None:
                missing.append(target)
    print(f"{len(entries) - len(missing)} of {len(entries)} NitroSense assets in place")
    if missing:
        print("not found in this NitroSense version:", *missing[:10], sep="\n  ")
        sys.exit(2)


if __name__ == "__main__":
    main()
