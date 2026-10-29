"""Verify every bundled asset against the accepted SHA-256 hashes in the manifest.

usage: check-acer-assets.py MANIFEST ASSET_DIRECTORY
"""
import hashlib
from pathlib import Path
import sys


def check(manifest, directory):
    entries = {}
    for line in Path(manifest).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        target, _, digest = line.split("\t")
        entries.setdefault(target, set()).add(digest)
    if not entries:
        raise ValueError("artwork manifest is empty")
    errors = []
    for target, digests in entries.items():
        path = Path(directory) / target
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            errors.append(f"{target}: {error.strerror}")
            continue
        if digest not in digests:
            errors.append(f"{target}: SHA-256 mismatch")
    return len(entries), errors


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip())
    try:
        count, errors = check(*sys.argv[1:])
    except (OSError, ValueError) as error:
        sys.exit(f"Cannot verify bundled NitroSense artwork: {error}")
    if errors:
        print("Bundled NitroSense artwork is incomplete or damaged:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        sys.exit(1)
    print(f"Verified all {count} bundled NitroSense assets")


if __name__ == "__main__":
    main()
