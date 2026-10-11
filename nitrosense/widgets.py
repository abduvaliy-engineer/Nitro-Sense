import math

from gi.repository import Gtk, Pango, PangoCairo

ARC_START = math.radians(135)
ARC_SWEEP = math.radians(270)


def _temp_color(fraction):
    # Cool cyan -> amber -> Nitro red as the reading climbs.
    stops = [(0.0, (0.16, 0.78, 0.86)), (0.6, (1.0, 0.66, 0.10)), (1.0, (0.89, 0.02, 0.17))]
    for (f0, c0), (f1, c1) in zip(stops, stops[1:]):
        if fraction <= f1:
            t = (fraction - f0) / (f1 - f0)
            return tuple(a + (b - a) * t for a, b in zip(c0, c1))
    return stops[-1][1]


class Gauge(Gtk.DrawingArea):
    def __init__(self, title, maximum=100.0, unit="°C"):
        super().__init__()
        self.title = title
        self.maximum = maximum
        self.unit = unit
        self.value = None
        self.caption = ""
        self.set_content_width(190)
        self.set_content_height(190)
        self.set_hexpand(True)
        self.add_css_class("gauge")
        self.set_draw_func(self._draw)

    def update(self, value, caption=""):
        if value == self.value and caption == self.caption:
            return
        self.value = value
        self.caption = caption
        self.queue_draw()

    def _text(self, cr, text, size, weight, y, rgba):
        layout = PangoCairo.create_layout(cr)
        font = Pango.FontDescription.from_string(f"Sans {weight} {size}")
        layout.set_font_description(font)
        layout.set_text(text, -1)
        _, logical = layout.get_pixel_extents()
        cr.set_source_rgba(*rgba)
        cr.move_to(self._cx - logical.width / 2, y - logical.height / 2)
        PangoCairo.show_layout(cr, layout)

    def _draw(self, _area, cr, width, height):
        size = min(width, height)
        self._cx, cy = width / 2, height / 2
        radius = size / 2 - 14
        line = max(8, size * 0.06)

        cr.set_line_cap(1)  # round
        cr.set_line_width(line)
        cr.set_source_rgba(1, 1, 1, 0.08)
        cr.arc(self._cx, cy, radius, ARC_START, ARC_START + ARC_SWEEP)
        cr.stroke()

        fg = (0.93, 0.93, 0.95, 1)
        dim = (0.62, 0.62, 0.68, 1)
        if self.value is not None:
            fraction = max(0.0, min(1.0, self.value / self.maximum))
            if fraction > 0:
                r, g, b = _temp_color(fraction)
                cr.set_source_rgb(r, g, b)
                cr.arc(self._cx, cy, radius, ARC_START, ARC_START + ARC_SWEEP * fraction)
                cr.stroke()
            value_text = f"{self.value:.0f}{self.unit}"
        else:
            value_text = "Off"

        self._text(cr, self.title.upper(), size * 0.065, "Bold", cy - size * 0.2, dim)
        self._text(cr, value_text, size * 0.15, "Bold", cy, fg)
        if self.caption:
            self._text(cr, self.caption, size * 0.065, "", cy + size * 0.2, dim)


class ModeCard(Gtk.ToggleButton):
    def __init__(self, icon, title, subtitle):
        super().__init__()
        self.add_css_class("mode-card")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.set_margin_top(12)
        box.set_margin_bottom(12)
        image = Gtk.Image.new_from_icon_name(icon)
        image.set_pixel_size(28)
        heading = Gtk.Label(label=title)
        heading.add_css_class("heading")
        sub = Gtk.Label(label=subtitle)
        sub.add_css_class("dim-label")
        sub.add_css_class("caption")
        sub.set_visible(bool(subtitle))
        sub.set_wrap(True)
        sub.set_justify(Gtk.Justification.CENTER)
        box.append(image)
        box.append(heading)
        box.append(sub)
        self.set_child(box)
        self.set_hexpand(True)


def section(title):
    label = Gtk.Label(label=title, xalign=0)
    label.add_css_class("section-title")
    return label
