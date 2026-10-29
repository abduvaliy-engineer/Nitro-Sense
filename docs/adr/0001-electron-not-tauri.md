# Electron on the system runtime, not Tauri

NitroSense is itself an Electron and Angular app, so running on Chromium lets NitroSense for Linux draw NitroSense's
layout, fonts, SVG artwork, Lottie animations and 3D avatar the same way, and lets every page be checked pixel by pixel
against Windows screenshots. We accept Electron's memory use (about 300 MB with the window open) and use the
distribution's shared Electron (`electron43` on Arch) instead of bundling one. Making the background part lighter is
tracked in issue #8.

## Considered Options

- **Tauri**: renders with WebKitGTK on Linux, which differs from Chromium in fonts, CSS/SVG details and WebGL, and has
  had rendering problems on NVIDIA with Wayland, the hardware this app targets.
- **Native GTK**: the first prototype (`nitrosense/`) was GTK; matching NitroSense's look by hand was dropped in favour
  of running the same web technology NitroSense uses.
