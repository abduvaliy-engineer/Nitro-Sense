# Acer artwork is fetched at install time, never committed

NitroSense's icons, fonts, backgrounds, animations and 3D models belong to Acer, so they are not in the repository or
in releases. The installer copies them from the user's own NitroSense: a Windows install on another drive, or the
Microsoft Store package downloaded from Microsoft's servers (about 340 MB, NitroSense 5.0). Every file is checked
against the SHA-256 manifest in `data/acer-assets.tsv`.

## Consequences

- Users without Windows download about 340 MB once, and get NitroSense 5.0's versions of a few images.
- New page artwork means new manifest rows, and each file must also exist in the Store build.
