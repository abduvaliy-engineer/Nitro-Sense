import json
import os
import threading
from pathlib import Path

from gi.repository import Adw, Gdk, GLib, Gtk

from . import __version__
from .driver import Driver, DriverError
from .sensors import Sensors, bios_version, model_name
from .widgets import Gauge, ModeCard, section

CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "nitrosense" / "state.json"

PROFILES = {
    "low-power": ("Eco", "power-profile-power-saver-symbolic"),
    "quiet": ("Quiet", "audio-volume-muted-symbolic"),
    "balanced": ("Balanced", "power-profile-balanced-symbolic"),
    "balanced-performance": ("Performance", "power-profile-performance-symbolic"),
    "performance": ("Turbo", "weather-storm-symbolic"),
}

LIGHT_EFFECTS = ["Static", "Breathing", "Neon", "Wave", "Shifting", "Zoom", "Meteor", "Twinkling"]
USB_LEVELS = [(0, "Off"), (10, "Until battery reaches 10%"), (20, "Until battery reaches 20%"), (30, "Until battery reaches 30%")]

SENSOR_INTERVAL_MS = 1000
LIVE_INTERVAL_MS = 2000
FAN_DEBOUNCE_MS = 350


def load_state():
    try:
        return json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(state, indent=2))
    except OSError:
        pass


def rgba_to_hex(rgba):
    return "".join(f"{round(c * 255):02X}" for c in (rgba.red, rgba.green, rgba.blue))


def hex_to_rgba(value):
    rgba = Gdk.RGBA()
    rgba.parse(f"#{value}")
    return rgba


class NitroSenseWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="NitroSense")
        self.set_default_size(980, 720)
        self.driver = Driver()
        self.sensors = Sensors()
        self.state = load_state()
        self.settings = {}
        self.features = set()
        self._syncing = False
        self._refreshing = False
        self._fan_timer = None

        self.toasts = Adw.ToastOverlay()
        stack = Adw.ViewStack()
        stack.add_titled_with_icon(self._build_home(), "home", "Home", "computer-symbolic")
        stack.add_titled_with_icon(self._build_lighting(), "lighting", "Lighting", "keyboard-brightness-symbolic")
        stack.add_titled_with_icon(self._build_settings(), "settings", "Settings", "emblem-system-symbolic")

        header = Adw.HeaderBar()
        switcher = Adw.ViewSwitcher(stack=stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        header.set_title_widget(switcher)
        brand = Gtk.Label(label="NITRO<span weight='light'>SENSE</span>", use_markup=True)
        brand.add_css_class("brand")
        header.pack_start(brand)

        bottom = Adw.ViewSwitcherBar(stack=stack)
        view = Adw.ToolbarView()
        view.add_top_bar(header)
        view.add_bottom_bar(bottom)
        view.set_content(stack)
        self.toasts.set_child(view)
        self.set_content(self.toasts)

        breakpoint = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 600sp"))
        breakpoint.add_setter(bottom, "reveal", True)
        breakpoint.add_setter(switcher, "visible", False)
        self.add_breakpoint(breakpoint)

        self._tick_sensors()
        self._refresh_settings()
        GLib.timeout_add(SENSOR_INTERVAL_MS, self._tick_sensors)
        GLib.timeout_add(LIVE_INTERVAL_MS, self._poll_live)
        self.connect("notify::is-active", lambda w, _p: w.is_active() and w._refresh_settings())

    # ---------- plumbing ----------

    def toast(self, message):
        self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(message), timeout=4))

    def run_async(self, func, on_done=None, on_error=None):
        def worker():
            try:
                result = func()
            except (DriverError, OSError) as exc:
                error = str(exc)
                GLib.idle_add(lambda: (on_error or self.toast)(error) and False)
                return
            if on_done:
                GLib.idle_add(lambda: on_done(result) and False)

        threading.Thread(target=worker, daemon=True).start()

    def write(self, func, success=None):
        def failed(message):
            self.toast(message)
            self._refresh_settings()

        self.run_async(func, on_done=lambda _r: success and self.toast(success), on_error=failed)

    # ---------- home ----------

    def _build_home(self):
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        page.set_margin_top(18)
        page.set_margin_bottom(24)
        page.set_margin_start(16)
        page.set_margin_end(16)

        gauges = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True,
                             max_children_per_line=3, min_children_per_line=1,
                             column_spacing=12, row_spacing=12)
        self.cpu_gauge = Gauge("CPU")
        self.gpu_gauge = Gauge("GPU")
        self.sys_gauge = Gauge("System")
        for gauge in (self.cpu_gauge, self.gpu_gauge, self.sys_gauge):
            card = Gtk.Box()
            card.add_css_class("card")
            card.add_css_class("gauge-card")
            card.append(gauge)
            gauges.append(card)
        page.append(gauges)

        page.append(section("Power Mode"))
        self.profile_box = Gtk.Box(spacing=8, homogeneous=True)
        self.profile_box.add_css_class("profile-row")
        self.profile_buttons = {}
        page.append(self.profile_box)
        self.ac_hint = Gtk.Label(xalign=0, wrap=True)
        self.ac_hint.add_css_class("dim-label")
        self.ac_hint.add_css_class("caption")
        page.append(self.ac_hint)

        page.append(section("Fan Control"))
        fans = Gtk.Box(spacing=8, homogeneous=True)
        self.fan_auto = ModeCard("emblem-synchronizing-symbolic", "Auto", "Firmware manages fans")
        self.fan_max = ModeCard("weather-windy-symbolic", "Max", "Both fans at full speed")
        self.fan_custom = ModeCard("preferences-other-symbolic", "Custom", "Set CPU and GPU fan speed")
        self.fan_max.set_group(self.fan_auto)
        self.fan_custom.set_group(self.fan_auto)
        for card, mode in ((self.fan_auto, "auto"), (self.fan_max, "max"), (self.fan_custom, "custom")):
            card.connect("toggled", self._on_fan_mode, mode)
            fans.append(card)
        page.append(fans)

        self.custom_revealer = Gtk.Revealer(transition_type=Gtk.RevealerTransitionType.SLIDE_DOWN)
        sliders = Adw.PreferencesGroup()
        sliders.set_description("A fan set to 0% returns to automatic control.")
        custom = self.state.get("custom_fan", {"cpu": 50, "gpu": 50})
        self.cpu_slider = self._fan_slider(sliders, "CPU Fan", custom["cpu"])
        self.gpu_slider = self._fan_slider(sliders, "GPU Fan", custom["gpu"])
        self.custom_revealer.set_child(sliders)
        page.append(self.custom_revealer)

        clamp = Adw.Clamp(maximum_size=900, child=page)
        return Gtk.ScrolledWindow(child=clamp, hscrollbar_policy=Gtk.PolicyType.NEVER)

    def _fan_slider(self, group, title, value):
        row = Adw.ActionRow(title=title)
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 5)
        scale.set_value(value)
        scale.set_hexpand(True)
        scale.set_size_request(260, -1)
        scale.set_draw_value(True)
        scale.set_value_pos(Gtk.PositionType.RIGHT)
        scale.set_format_value_func(lambda _s, v: f"{v:.0f}%")
        for mark in (0, 50, 100):
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, None)
        scale.connect("value-changed", self._on_fan_slider)
        row.add_suffix(scale)
        group.add(row)
        return scale

    def _rebuild_profiles(self, choices):
        if list(self.profile_buttons) == choices:
            return
        while child := self.profile_box.get_first_child():
            self.profile_box.remove(child)
        self.profile_buttons = {}
        first = None
        for choice in choices:
            label, icon = PROFILES.get(choice, (choice.replace("-", " ").title(), "power-profile-balanced-symbolic"))
            button = ModeCard(icon, label, "")
            button.add_css_class("profile-card")
            if first is None:
                first = button
            else:
                button.set_group(first)
            button.connect("toggled", self._on_profile, choice)
            self.profile_box.append(button)
            self.profile_buttons[choice] = button

    def _on_profile(self, button, profile):
        if self._syncing or not button.get_active():
            return
        label = PROFILES.get(profile, (profile,))[0]
        self.write(lambda: self.driver.set_thermal_profile(profile), f"Power mode: {label}")

    def _on_fan_mode(self, button, mode):
        if not button.get_active():
            return
        self.custom_revealer.set_reveal_child(mode == "custom")
        if self._syncing:
            return
        if mode == "auto":
            self.write(lambda: self.driver.set_fan_speed(0, 0), "Fans: Auto")
        elif mode == "max":
            self.write(lambda: self.driver.set_fan_speed(100, 100), "Fans: Max")
        else:
            self._apply_custom_fans()

    def _on_fan_slider(self, _scale):
        if self._syncing or not self.fan_custom.get_active():
            return
        if self._fan_timer:
            GLib.source_remove(self._fan_timer)
        self._fan_timer = GLib.timeout_add(FAN_DEBOUNCE_MS, self._apply_custom_fans)

    def _apply_custom_fans(self):
        self._fan_timer = None
        cpu, gpu = round(self.cpu_slider.get_value()), round(self.gpu_slider.get_value())
        self.state["custom_fan"] = {"cpu": cpu, "gpu": gpu}
        save_state(self.state)
        self.write(lambda: self.driver.set_fan_speed(cpu, gpu))
        return False

    # ---------- lighting ----------

    def _build_lighting(self):
        self.lighting_stack = Gtk.Stack()
        unavailable = Adw.StatusPage(
            icon_name="keyboard-brightness-symbolic",
            title="Keyboard lighting unavailable",
            description="No ENEK5130 controller or linuwu-sense four-zone keyboard was found.",
        )
        self.lighting_stack.add_named(unavailable, "unavailable")

        light = self.state.get("lighting", {})
        page = Adw.PreferencesPage()

        effect_group = Adw.PreferencesGroup(title="Effect")
        self.effect_row = Adw.ComboRow(title="Mode", model=Gtk.StringList.new(LIGHT_EFFECTS))
        self.effect_row.set_selected(light.get("mode", 0))
        self.effect_row.connect("notify::selected", self._on_effect_changed)
        effect_group.add(self.effect_row)

        self.color_button = Gtk.ColorDialogButton(dialog=Gtk.ColorDialog(with_alpha=False))
        self.color_button.set_rgba(hex_to_rgba(light.get("color", "E3062C")))
        self.color_button.set_valign(Gtk.Align.CENTER)
        self.color_row = Adw.ActionRow(title="Color")
        self.color_row.add_suffix(self.color_button)
        effect_group.add(self.color_row)

        self.brightness_row = Adw.SpinRow.new_with_range(0, 100, 5)
        self.brightness_row.set_title("Brightness")
        self.brightness_row.set_value(light.get("brightness", 100))
        effect_group.add(self.brightness_row)

        self.speed_row = Adw.SpinRow.new_with_range(0, 9, 1)
        self.speed_row.set_title("Speed")
        self.speed_row.set_value(light.get("speed", 4))
        effect_group.add(self.speed_row)

        self.direction_row = Adw.ComboRow(title="Direction", model=Gtk.StringList.new(["Right to left", "Left to right"]))
        self.direction_row.set_selected(light.get("direction", 1) - 1)
        effect_group.add(self.direction_row)
        page.add(effect_group)

        self.zone_group = Adw.PreferencesGroup(title="Zones", description="Per-zone colors for the Static effect.")
        self.zone_toggle = Adw.SwitchRow(title="Use per-zone colors", active=light.get("per_zone", False))
        self.zone_group.add(self.zone_toggle)
        zone_row = Adw.ActionRow(title="Zone colors", subtitle="Left to right")
        self.zone_buttons = []
        for value in light.get("zones", ["E3062C", "E3062C", "E3062C", "E3062C"]):
            button = Gtk.ColorDialogButton(dialog=Gtk.ColorDialog(with_alpha=False), valign=Gtk.Align.CENTER)
            button.set_rgba(hex_to_rgba(value))
            zone_row.add_suffix(button)
            self.zone_buttons.append(button)
        self.zone_group.add(zone_row)
        page.add(self.zone_group)

        apply_group = Adw.PreferencesGroup()
        apply = Gtk.Button(label="Apply Lighting", halign=Gtk.Align.CENTER)
        apply.add_css_class("suggested-action")
        apply.add_css_class("pill")
        apply.connect("clicked", self._on_apply_lighting)
        apply_group.add(apply)
        page.add(apply_group)

        self.lighting_stack.add_named(page, "controls")
        self._on_effect_changed()
        return self.lighting_stack

    def _on_effect_changed(self, *_args):
        static = self.effect_row.get_selected() == 0
        self.speed_row.set_sensitive(not static)
        self.direction_row.set_sensitive(not static)
        self.zone_group.set_sensitive(static)

    def _on_apply_lighting(self, _button):
        mode = self.effect_row.get_selected()
        color = self.color_button.get_rgba()
        brightness = int(self.brightness_row.get_value())
        speed = int(self.speed_row.get_value())
        direction = self.direction_row.get_selected() + 1
        per_zone = mode == 0 and self.zone_toggle.get_active()
        zones = [rgba_to_hex(b.get_rgba()) for b in self.zone_buttons]

        self.state["lighting"] = {
            "mode": mode, "color": rgba_to_hex(color), "brightness": brightness,
            "speed": speed, "direction": direction, "per_zone": per_zone, "zones": zones,
        }
        save_state(self.state)

        if per_zone:
            self.write(lambda: self.driver.set_per_zone_mode(zones, brightness), "Lighting applied")
        else:
            rgb = [round(c * 255) for c in (color.red, color.green, color.blue)]
            self.write(lambda: self.driver.set_four_zone_mode(mode, speed, brightness, direction, *rgb), "Lighting applied")

    # ---------- settings ----------

    def _build_settings(self):
        page = Adw.PreferencesPage()
        self.switches = {}

        battery = Adw.PreferencesGroup(title="Battery")
        self._switch(battery, "battery_limiter", "Battery Charge Limit",
                     "Stop charging at 80% to extend battery lifespan")
        self._switch(battery, "battery_calibration", "Battery Calibration",
                     "Fully charge and discharge to recalibrate. Keep the charger plugged in.",
                     confirm=True)
        page.add(battery)

        charging = Adw.PreferencesGroup(title="Charging")
        self.usb_row = Adw.ComboRow(title="Power-off USB Charging",
                                    subtitle="Charge devices through USB while the laptop is off",
                                    model=Gtk.StringList.new([label for _, label in USB_LEVELS]))
        self.usb_row.connect("notify::selected", self._on_usb)
        charging.add(self.usb_row)
        page.add(charging)

        system = Adw.PreferencesGroup(title="System")
        self._switch(system, "backlight_timeout", "Keyboard Backlight Timeout",
                     "Turn the keyboard backlight off after 30 seconds of inactivity")
        self._switch(system, "lcd_override", "LCD Overdrive",
                     "Reduce display response time for fast motion")
        self._switch(system, "boot_animation_sound", "Boot Animation and Sound",
                     "Play the Acer logo animation and sound at power on")
        page.add(system)

        about = Adw.PreferencesGroup(title="About")
        self.about_model = Adw.ActionRow(title="Model", subtitle=model_name())
        self.about_bios = Adw.ActionRow(title="BIOS", subtitle=bios_version())
        self.about_daemon = Adw.ActionRow(title="Driver", subtitle="linuwu-sense")
        self.about_rgb = Adw.ActionRow(title="Keyboard Lighting", subtitle="not found")
        self.about_app = Adw.ActionRow(title="NitroSense for Linux", subtitle=__version__)
        for row in (self.about_model, self.about_bios, self.about_daemon, self.about_rgb, self.about_app):
            row.add_css_class("property")
            about.add(row)
        page.add(about)
        return page

    def _switch(self, group, feature, title, subtitle, confirm=False):
        row = Adw.SwitchRow(title=title, subtitle=subtitle)
        row.connect("notify::active", self._on_switch, feature, confirm)
        group.add(row)
        self.switches[feature] = row

    def _on_switch(self, row, _pspec, feature, confirm):
        if self._syncing:
            return
        enabled = row.get_active()
        if confirm and enabled:
            dialog = Adw.AlertDialog(
                heading="Start battery calibration?",
                body="Keep the charger connected. The battery will charge fully, discharge, then charge again. "
                     "This can take several hours.",
            )
            dialog.add_response("cancel", "Cancel")
            dialog.add_response("start", "Start")
            dialog.set_response_appearance("start", Adw.ResponseAppearance.SUGGESTED)

            def on_response(_dialog, response):
                if response == "start":
                    self.write(lambda: self.driver.set_flag(feature, True), f"{row.get_title()} on")
                else:
                    self._syncing = True
                    row.set_active(False)
                    self._syncing = False

            dialog.connect("response", on_response)
            dialog.present(self)
            return
        self.write(lambda: self.driver.set_flag(feature, enabled),
                   f"{row.get_title()} {'on' if enabled else 'off'}")

    def _on_usb(self, row, _pspec):
        if self._syncing:
            return
        level, label = USB_LEVELS[row.get_selected()]
        self.write(lambda: self.driver.set_usb_charging(level), f"Power-off USB charging: {label}")

    # ---------- refresh ----------

    def _tick_sensors(self):
        r = self.sensors.read()
        self.cpu_gauge.update(r.cpu_temp, f"{r.cpu_rpm} RPM" if r.cpu_rpm is not None else "")
        self.gpu_gauge.update(r.gpu_temp, f"{r.gpu_rpm} RPM" if r.gpu_rpm is not None else "")
        self.sys_gauge.update(r.sys_temp, "")
        return True

    def _refresh_settings(self):
        if self._refreshing:
            return True
        self._refreshing = True

        def done(settings):
            self._refreshing = False
            self._apply_settings(settings)

        def failed(message):
            self._refreshing = False
            self.about_daemon.set_subtitle(f"unavailable: {message}")
            if self.settings != {}:
                self.toast(message)
            self.settings = {}
            self._set_controls_sensitive(False)

        self.run_async(self.driver.settings, done, failed)
        return True

    def _poll_live(self):
        if self.settings and not self._refreshing:
            self.run_async(self.driver.live, lambda live: self._apply_settings({**self.settings, **live}),
                           on_error=lambda _m: None)
        return True

    def _set_controls_sensitive(self, available):
        features = self.features if available else set()
        self.profile_box.set_sensitive("thermal_profile" in features)
        for card in (self.fan_auto, self.fan_max, self.fan_custom):
            card.set_sensitive("fan_speed" in features)
        self.custom_revealer.set_sensitive("fan_speed" in features)
        for feature, row in self.switches.items():
            row.set_visible(feature in features or not available)
            row.set_sensitive(feature in features)
        self.usb_row.set_sensitive("usb_charging" in features)
        rgb = {"four_zone_mode", "per_zone_mode"} & features
        self.lighting_stack.set_visible_child_name("controls" if rgb else "unavailable")
        self.zone_toggle.set_sensitive("per_zone_mode" in features)

    def _apply_settings(self, settings):
        self.settings = settings
        self.features = set(settings.get("available_features", []))
        self._syncing = True
        try:
            self._set_controls_sensitive(True)
            self.about_daemon.set_subtitle(f"linuwu-sense · {settings.get('laptop_type', '?').title()} interface")
            self.about_rgb.set_subtitle(settings.get("rgb_device") or "not found")

            profile = settings.get("thermal_profile", {})
            self._rebuild_profiles(profile.get("available", []))
            if button := self.profile_buttons.get(profile.get("current")):
                button.set_active(True)
            on_battery = profile.get("available") and "performance" not in profile["available"]
            self.ac_hint.set_label("Turbo needs the charger connected." if on_battery else "")
            self.ac_hint.set_visible(bool(on_battery))

            fan = settings.get("fan_speed")
            if fan:
                cpu, gpu = int(fan.get("cpu") or 0), int(fan.get("gpu") or 0)
                if (cpu, gpu) == (0, 0):
                    self.fan_auto.set_active(True)
                elif (cpu, gpu) == (100, 100):
                    self.fan_max.set_active(True)
                else:
                    self.fan_custom.set_active(True)
                    if self._fan_timer is None:
                        self.cpu_slider.set_value(cpu)
                        self.gpu_slider.set_value(gpu)

            for feature, row in self.switches.items():
                if feature in settings:
                    row.set_active(str(settings[feature]) == "1")

            if "usb_charging" in settings:
                levels = [level for level, _ in USB_LEVELS]
                try:
                    self.usb_row.set_selected(levels.index(int(settings["usb_charging"])))
                except ValueError:
                    pass
        finally:
            self._syncing = False
