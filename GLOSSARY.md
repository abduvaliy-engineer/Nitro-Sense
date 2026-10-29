# NitroSense for Linux

An unofficial Linux recreation of Acer's NitroSense control center for Acer Nitro laptops. It copies NitroSense's
pages and behaviour, and controls the laptop without Acer's Windows services.

## Language

### Product

**NitroSense**:
Acer's Windows control center for its gaming laptops, and the reference this project copies.
_Avoid_: the original, the Acer app

**NitroSense for Linux**:
This project: a Linux recreation of NitroSense.
_Avoid_: Nitro-Sense, the replica, the clone

**Windows-only feature**:
A NitroSense feature that needs Windows or Acer's Windows services. NitroSense for Linux does not build it; where the
app already shows one, it stays as an unavailable control.
_Avoid_: unsupported feature

**Unavailable control**:
A NitroSense control that is shown but disabled, with a hint saying why: "Not available on Linux yet", or "Not
available on <desktop>" when only the running desktop lacks it.
_Avoid_: hidden control, greyed-out control, placeholder

**Own design**:
A page or dialog that NitroSense does not have, or that replaces a NitroSense one, drawn in NitroSense's look. Made
only when the owner asks for one.
_Avoid_: custom page, redesign

**Acer artwork**:
Acer's icons, fonts, backgrounds, animations and 3D models from NitroSense. They belong to Acer and are never part of
this project's source.
_Avoid_: assets, resources

### Layout

**Side panel**:
The column on the right of the window that holds the widgets.
_Avoid_: widget panel, sidebar

**Widget**:
One card in the side panel, such as the Scenario, monitoring, Live Update or app shortcut card.
_Avoid_: card

### Scenarios

**Scenario**:
A named set of settings that are applied together: the Mode on AC power and on battery, fan control and keyboard
lighting.
_Avoid_: profile, scenario profile

**Mode**:
The laptop's power mode: Quiet, Balanced, Performance or Turbo on AC power, and Eco or Balanced on battery.
_Avoid_: platform profile, power profile, performance mode

**App Sync**:
Applying a Scenario automatically while one of its linked apps is in front, and going back to the user's own choice
when none is.
_Avoid_: auto-switch

**Linked app**:
An app attached to a Scenario for App Sync.
_Avoid_: bound app

### Keys

**NitroSense key**:
The keyboard key that opens NitroSense. It sends the same key code on every Nitro laptop.
_Avoid_: Nitro key, presentation key

**Mode Switch Key**:
The keyboard key that cycles through the Modes or toggles Turbo. On some Nitro laptops it never reaches the operating
system.
_Avoid_: mode key

### Updates

**Live Update**:
NitroSense for Linux updating itself to the newest Release.
_Avoid_: auto-update, self-update

**Acer driver updates**:
NitroSense's own Live Update, which installs Acer's Windows drivers and apps. It is a Windows-only feature.
_Avoid_: Live Update (for this meaning)

### Process

**Step**:
One NitroSense page or feature, taken from research to an approved merge. Each Step raises the minor version.
_Avoid_: milestone, phase, sprint

**Polish**:
A small fix to something already shipped. It raises the patch version.
_Avoid_: hotfix

**Release**:
Publishing everything merged since the previous Release as a new numbered version that users can update to.
_Avoid_: deploy, ship

**Complete**:
The state in which every NitroSense feature that can work on Linux works. Windows-only features don't count. Reaching
it is Release 1.0.0.
_Avoid_: one-to-one, 1:1, feature-complete
