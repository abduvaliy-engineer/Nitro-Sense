# NitroSense for Linux

Unofficial recreation of Acer's NitroSense control center for Acer Nitro laptops on Linux. It aims to look and
behave like NitroSense on Windows, and talks to the hardware through the [linuwu-sense](https://github.com/0x7375646F/Linuwu-Sense)
kernel driver.

> **Status: early development (v0.7.0).** Not every page is done yet. Tested on an Acer Nitro ANV16S-41 running
> Arch Linux (Omarchy / Hyprland).

## Features

| Area | What works |
|---|---|
| Home | Live CPU / GPU / system temperature gauges, GPU / CPU frequency and usage, 3D mode avatar, device / battery / driver card |
| Side panel | Scenario profiles, monitoring tiles (configurable), update check against GitHub releases, app shortcuts |
| Scenario → Mode | Quiet / Balanced / Performance / Turbo (Eco / Balanced on battery), GPU / CPU clock gauges, mode switch key behavior |
| Scenario → Fan Control | Auto / Max / Custom with per-fan speed and Auto toggle |
| Scenario → Pulsar Lighting | Keyboard RGB: Global effects (Static, Breathing, Neon, Wave, Ripple, Zoom, Snake, Disco) with brightness, speed, direction and a color wheel; Area mode with a color per keyboard zone; the keyboard flashes the mode color when the power mode changes |
| Scenario profiles | Add, rename, duplicate, restore and remove profiles; applying one sets power mode, fans and lighting |

Planned: Personal Settings (battery charge limit, USB charging, boot animation, LCD overdrive), the Monitoring page
and an install script.

### Keyboard lighting

Two kinds of keyboards are supported, picked automatically:

- **ENEK5130 HID keyboards** (e.g. Nitro ANV16S-41): written through `/dev/hidraw*` with the same reports Acer's
  Windows lighting service sends. Needs `python3`, because Node.js cannot issue the HID ioctl itself.
- **linuwu-sense `four_zoned_kb`** (e.g. Nitro AN515-58, AN16-41, Predator PHN16-71): written through the driver's
  `four_zone_mode` and `per_zone_mode` files.

The eyedropper uses `hyprpicker` when it is installed. DAMX also drives the keyboard, so use one app at a time for
lighting.

## Requirements

- An Acer Nitro laptop supported by **linuwu-sense** (installed with DKMS, module loaded).
- **Electron** (developed with the system `electron43` on Arch).
- The udev rule in `data/70-nitrosense.rules`, which gives the `linuwu_sense` group write access to the driver's
  controls, the platform profile and the keyboard lighting (ENEK5130 hidraw or `four_zoned_kb`). Your user must be
  in that group.
- **python3** for ENEK5130 keyboard lighting.
- **NitroSense artwork** in `app/assets/acer/` (icons, fonts, background, 3D models). These files belong to Acer and
  are not part of this repository; the install script will take them from Acer's official NitroSense package.

## Running

```sh
cd app
electron43 .          # normal start
electron43 . --dev    # reloads the window when files change
```

The app is single-instance: starting it again focuses the open window.

## Project layout

```
app/
  main.js, preload.js     Electron main process and the renderer bridge
  backend/                sensors, controls (sysfs writes), lighting, settings, updates, shortcuts
  renderer/               UI: pages/, side panel, shared components
  vendor/                 three.js r125 and lottie-web (MIT, licenses included)
data/                     udev rule and desktop entry
nitrosense/               first GTK prototype (superseded)
```

## Disclaimer

Not affiliated with or endorsed by Acer. NitroSense, Nitro and Predator are trademarks of Acer Inc.
Changing fan speeds and power modes is at your own risk.
