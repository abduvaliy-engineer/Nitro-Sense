# linuwu-sense is the only hardware backend

NitroSense for Linux controls the laptop directly through the linuwu-sense kernel driver's sysfs files, which a udev
rule makes writable for the `linuwu_sense` group, and through the keyboard's HID reports. It does not go through DAMX,
the other Linux alternative to NitroSense, which runs its own root daemon. This way the app needs no root daemon and
no second app. DAMX's daemon also writes to the keyboard, so the two must not drive the lighting at the same time.
