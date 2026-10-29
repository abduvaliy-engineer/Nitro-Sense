"""Exercise bundle verification without relying on the real artwork."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "checker", Path(__file__).resolve().parents[1] / "tools/check-acer-assets.py"
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class BundleVerification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manifest = self.root / "manifest.tsv"
        self.manifest.write_text("# Accepted variants\n" + "".join(
            f"icon.svg\tsource.svg\t{hashlib.sha256(data).hexdigest()}\n"
            for data in (b"new", b"old")
        ))

    def test_accepts_each_variant_and_counts_destinations_once(self):
        for content in (b"new", b"old"):
            with self.subTest(content=content):
                (self.root / "icon.svg").write_bytes(content)
                self.assertEqual(checker.check(self.manifest, self.root), (1, []))

    def test_rejects_corrupt_file(self):
        (self.root / "icon.svg").write_bytes(b"corrupt")
        self.assertEqual(checker.check(self.manifest, self.root)[1],
                         ["icon.svg: SHA-256 mismatch"])

    def test_rejects_missing_file(self):
        self.assertEqual(len(checker.check(self.manifest, self.root)[1]), 1)

    def test_rejects_empty_manifest(self):
        self.manifest.write_text("# No entries\n")
        with self.assertRaises(ValueError):
            checker.check(self.manifest, self.root)


if __name__ == "__main__":
    unittest.main()
