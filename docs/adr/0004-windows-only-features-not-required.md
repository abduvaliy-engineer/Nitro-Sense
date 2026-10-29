# 1.0.0 does not wait for Windows-only features

NitroSense for Linux copies NitroSense's pages, but Release 1.0.0 only requires the features that can work on Linux.
Windows-only features, such as the Experience Zone's promotions for Acer's Windows apps, are not built. Where the app
already shows one, it stays as an unavailable control instead of being removed, so it is easy to bring back if Linux
support ever appears.

## Considered Options

- **Build every NitroSense page, with its Windows-only parts greyed out**: most faithful, but means building pages
  that can never work.
- **Remove Windows-only features from the app**: cleaner, but whatever was already built would have to be rebuilt if
  Linux support appears.
- **Hide them behind an on/off switch**: keeps the code, but users no longer see that the feature exists.
- **Every control must work**: impossible without Windows.
