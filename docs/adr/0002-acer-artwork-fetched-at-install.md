# Bundle required Acer artwork

Supersedes the original decision to fetch artwork at install time.

All artwork listed in `data/acer-assets.tsv` is included under `app/assets/acer/` in the repository and
therefore in GitHub source archives used by fresh installs and Live Update. Acer retains ownership of
these icons, fonts, backgrounds, animations and 3D models.

## Consequences

- Installation and updates never download a Microsoft Store package or scan Windows drives.
- The installer verifies the bundle before system changes; CI and releases enforce the same manifest.
- Adding artwork requires committing the file and its SHA-256 manifest entry together.
- `--assets PATH` remains an optional import from a local package. Store fetching is a maintainer tool only.
- Packages, Electron and the Linux driver can still require network access.
