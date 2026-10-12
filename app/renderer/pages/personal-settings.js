// Personal Settings tab (NitroSense app-personal-settings): a sticky section menu with scroll spy beside one column
// of cards. Every control writes its linuwu-sense attribute at once; controls Linux has no backend for yet are shown
// greyed out instead of hidden.
(() => {
  const ACER = "../assets/acer";
  const LINUX_LATER = "Not available on Linux yet";
  const NO_DRIVER = "Not supported by the linuwu-sense driver on this laptop";
  const USB_LIMIT_KEY = "personal.usbChargeLimit";
  const USB_LIMITS = [10, 20, 30];
  const GPU_MODES = { optimus: "Optimus", dgpu: "NVIDIA GPU only" };
  const SPY_DELAY = 50;
  const BACKLIGHT_DELAY = 500;
  const SCROLL_MARGIN = 60;

  const SECTIONS = [
    { id: "GPUOperating", title: "GPU Operating", icon: "ic_personal_gpu", build: gpuCard },
    { id: "Battery_&_Charge", title: "Battery & Charge", icon: "ic_personal_batterycharge", build: batteryCard },
    { id: "Screen", title: "Screen", icon: "ic_personal_screen", build: screenCard },
    { id: "Keyboard", title: "Keyboard", icon: "ic_personal_keyboard", build: keyboardCard },
    { id: "SystemBootEffect", title: "System Boot Effect", icon: "ic_personal_systemboot", build: bootCard },
  ];

  const CHARGE_MODES = [
    { limiter: 1, name: "Optimized Battery Charging", icon: "personal_battery_optimiz", recommended: true,
      intro: "To reduce battery aging, charging capacity will be limited to 80%." },
    { limiter: 0, name: "Full Battery Charging", icon: "personal_battery_full",
      intro: "Charging to maximum capacity for longer mobile to use." },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(src, className) {
    const image = el("img", className);
    image.src = src;
    image.alt = "";
    return image;
  }

  function labelled(tag, className, ariaLabel, text) {
    const node = el(tag, className, text);
    node.setAttribute("aria-label", ariaLabel);
    return node;
  }

  function block(...children) {
    const node = el("div", "ps-block");
    node.append(...children);
    return node;
  }

  // Shown but inert, with the reason as its tooltip.
  function unavailable(node, reason = LINUX_LATER) {
    node.classList.add("ps-unavailable");
    node.title = reason;
    for (const button of node.querySelectorAll("button")) button.disabled = true;
    return node;
  }

  // NitroSense's .switch-button inside its wrapper button: 48×24 with padding, "bare" 40×16, "boot" 40×36.
  function switchButton(ariaLabel, variant = "") {
    const button = labelled("button", `ps-switch-btn ${variant}`.trim(), ariaLabel);
    button.setAttribute("role", "checkbox");
    const track = el("div", "ns-switch");
    track.append(el("span", "ns-switch-knob"));
    button.append(track);
    return {
      root: button,
      set(on) {
        track.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
      },
    };
  }

  function dropdown(ariaLabel) {
    const trigger = el("button", "wi-dropdown ps-dropdown");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
    const text = el("span", "wi-dropdown-text");
    trigger.append(text, el("div", "wi-dropdown-arrow"));
    const row = el("div", "ps-dropdown-row");
    row.append(trigger);
    return { root: row, trigger, text };
  }

  // ---------- cards ----------

  function gpuCard(page) {
    const menu = dropdown();
    menu.text.textContent = GPU_MODES[page.values.gpu_mode] ?? GPU_MODES.optimus;
    const modes = el("div", "ps-gpu-modes");
    modes.append(menu.root);
    return [unavailable(block(el("span", "ps-label ps-gap4", "Choosing the operating mode of the GPU."), modes))];
  }

  function batteryCard(page) {
    const { values } = page;
    const radios = [];
    const list = el("div", "ps-modes");
    for (const mode of CHARGE_MODES) {
      const button = labelled("button", "ps-mode", `switch ${mode.name}`);
      const radio = el("div", "ns-radio");
      radios.push([radio, mode.limiter]);
      button.append(radio, icon(`${ACER}/personal/${mode.icon}.svg`), el("span", "ps-label", mode.name));
      button.addEventListener("click", () => page.set("battery_limiter", mode.limiter));
      const line = el("div", "ps-mode-line");
      line.append(button);
      const notes = el("div", "ps-mode-notes");
      if (mode.recommended) notes.append(el("span", "", "(Recommended)"));
      notes.append(el("span", "", mode.intro));
      const item = el("div");
      item.append(line, notes);
      list.append(item);
    }
    const link = el("button", "ps-link");
    link.append(el("span", "", "See more health information of battery"), icon(`${ACER}/light/ic_textlink_arrow.svg`));
    link.addEventListener("click", () => window.NitroApp?.selectTab("Checkup"));
    const chargeMode = block(el("span", "ps-label ps-modes-title", "Battery Charge Mode"), list, link);
    if (values.battery_limiter === null) unavailable(chargeMode, NO_DRIVER);

    const usbSwitch = switchButton("Power-off USB Charger");
    usbSwitch.root.addEventListener("click", () => page.set("usb_charging", page.usbOn() ? 0 : page.usbLimit));
    const limitMenu = dropdown();
    limitMenu.trigger.addEventListener("click", () => {
      limitMenu.trigger.classList.add("open");
      window.NitroMenu.open(limitMenu.trigger, USB_LIMITS.map((limit) => ({
        label: `${limit}%`,
        active: limit === page.values.usb_charging,
        onSelect: () => page.setUsbLimit(limit),
      })), { width: 300, onClose: () => limitMenu.trigger.classList.remove("open") });
    });
    const limit = el("div", "ps-limit");
    limit.append(
      el("span", "ps-label ps-gap4", "Charge Limit While Using Battery Power"),
      el("span", "ps-intro", "On battery power, stop charging when the battery reaches:"),
      limitMenu.root,
    );
    const usb = block(
      el("span", "ps-label ps-gap4", "Power-off USB Charger"),
      el("span", "ps-intro ps-gap8", "Charge mobile devices via the designated USB port even when the laptop is off or in Hibernate mode, and on battery power."),
      usbSwitch.root,
      limit,
    );
    if (values.usb_charging === null) unavailable(usb, NO_DRIVER);

    page.renderers.push(() => {
      for (const [radio, limiter] of radios) radio.classList.toggle("on", page.values.battery_limiter === limiter);
      const on = page.usbOn();
      usbSwitch.set(on);
      limit.hidden = !on;
      limitMenu.text.textContent = `${page.values.usb_charging}%`;
      limitMenu.trigger.setAttribute("aria-label", `Charge Limit While Using Battery Power${page.values.usb_charging}%`);
    });
    return [chargeMode, el("hr", "ps-rule ps-rule-wide"), usb];
  }

  function screenCard(page) {
    const bluelight = switchButton("Bluelight Shield™");
    bluelight.set(false);
    const lcdSwitch = switchButton("LCD overdrive enabled toggle");
    lcdSwitch.root.addEventListener("click", () => page.set("lcd_override", page.values.lcd_override === 1 ? 0 : 1));
    const lcd = block(el("span", "ps-label ps-gap8", "LCD Overdrive"), lcdSwitch.root);
    if (page.values.lcd_override === null) unavailable(lcd, NO_DRIVER);
    page.renderers.push(() => lcdSwitch.set(page.values.lcd_override === 1));
    return [
      unavailable(block(
        el("span", "ps-label ps-gap4", "Bluelight Shield™"),
        el("span", "ps-intro ps-gap8", "Apply Acer's Bluelight Shield™ settings to protect your eyes."),
        bluelight.root,
      )),
      el("hr", "ps-rule ps-rule-tight"),
      lcd,
    ];
  }

  function keyboardCard(page) {
    const sticky = switchButton("sticky keys enabled toggle", "bare");
    sticky.set(false);
    const backlightSwitch = switchButton("Backlight 30s enabled toggle", "bare");
    // NitroSense flips the switch at once and sends only the last state of quick toggles.
    backlightSwitch.root.addEventListener("click", () => {
      page.values.backlight_timeout = page.values.backlight_timeout === 1 ? 0 : 1;
      page.render();
      clearTimeout(page.backlightTimer);
      page.backlightTimer = setTimeout(page.flushBacklight, BACKLIGHT_DELAY);
    });
    const backlight = block(el("span", "ps-label ps-gap8 ps-backlight-label", "Backlight off after 30 seconds"), backlightSwitch.root);
    if (page.values.backlight_timeout === null) unavailable(backlight, NO_DRIVER);
    page.renderers.push(() => backlightSwitch.set(page.values.backlight_timeout === 1));
    return [
      unavailable(block(
        el("span", "ps-label ps-gap4", "Sticky keys"),
        el("span", "ps-intro ps-gap8", "Press one key at a time for keyboard shortcuts."),
        sticky.root,
      )),
      backlight,
    ];
  }

  // app-custom-boot-logo: the firmware logo preview with Browse, Restore and full-screen buttons.
  function logoPreview() {
    const box = el("div", "ps-logo");
    const display = el("div", "ps-logo-screen");
    display.append(icon(`${ACER}/personal/nitro_bios_1072x864.png`));
    const browse = labelled("button", "custom-btn ps-logo-browse", "open profile");
    browse.append(icon(`${ACER}/personal/setting_bootlogo_edit.png`));
    const reset = labelled("button", "custom-btn ps-logo-reset", "reset boot logo");
    reset.append(icon(`${ACER}/personal/setting_bootlogo_restore.png`), el("p", "", "Restore to default"));
    // Restore only shows once a custom logo is set.
    const resetBox = el("div", "ps-logo-reset-box hide-reset");
    resetBox.append(reset);
    const full = labelled("button", "custom-btn ps-logo-full", "boot logo full screen");
    full.append(icon(`${ACER}/personal/setting_bootlogo_full.png`));
    const row = el("div", "ps-logo-bar-row");
    row.append(resetBox, full);
    const bar = el("div", "ps-logo-bar");
    bar.append(row);
    box.append(icon(`${ACER}/personal/setting_bootlogo_bg.png`, "ps-logo-frame"), display, browse, bar);
    return box;
  }

  // NitroSense limits the logo to 40 % of the display resolution.
  function logoDimension() {
    const scale = window.devicePixelRatio;
    return `${Math.floor(0.4 * Math.round(screen.width * scale))} x ${Math.floor(0.4 * Math.round(screen.height * scale))}`;
  }

  function bootCard(page) {
    const bootSwitch = switchButton("Boot sound enabled toggle", "boot");
    bootSwitch.root.addEventListener("click", () => page.set("boot_animation_sound", page.values.boot_animation_sound === 1 ? 0 : 1));
    const boot = block(el("span", "ps-label ps-gap8", "System boot animation & sound"), bootSwitch.root);
    if (page.values.boot_animation_sound === null) unavailable(boot, NO_DRIVER);

    const preview = el("div", "ps-logo-wrap");
    preview.append(logoPreview());
    const enabled = el("div", "ps-logo-texts");
    enabled.append(
      el("p", "ps-logo-text", "NitroSense can let you customize boot logo now. Click the Browse button below and choose your preferred image as boot logo."),
      preview,
      el("p", "ps-logo-note", "*Supported image format:"),
      el("p", "ps-logo-text", "jpeg/gif (< 35 MB, color depth < 32-bit)"),
      el("p", "ps-logo-note", "*Dimension limitation (Width x Height):"),
      el("p", "ps-logo-text", logoDimension()),
    );
    const disabled = el("div", "ps-logo-texts");
    disabled.append(el("p", "ps-logo-text", "You must turn on system boot animation & sound to enable boot logo customization."));
    const logo = el("div", "ps-logo-block");
    logo.append(el("p", "ps-logo-title", "Boot Logo Customization"), enabled, disabled);
    page.renderers.push(() => {
      bootSwitch.set(page.values.boot_animation_sound === 1);
      enabled.hidden = page.values.boot_animation_sound === 0;
      disabled.hidden = !enabled.hidden;
    });
    return [block(boot, unavailable(logo))];
  }

  // ---------- page ----------

  let current = null;

  function build(page, options) {
    const content = el("div", "ps-content");
    const row = el("div", "ps-row");

    const menu = el("div", "ps-menu");
    for (const section of SECTIONS) {
      const item = el("button", "ps-menu-item");
      const line = el("div", "ps-menu-line");
      const anchor = el("div", "ps-anchor");
      anchor.append(icon(`${ACER}/personal/personal_anchor.svg`));
      line.append(anchor, el("div", "ps-menu-label", section.title));
      item.append(line);
      item.addEventListener("click", () => page.scrollTo(section.id));
      menu.append(item);
      page.menuItems.set(section.id, item);
    }
    const leftInner = el("div", "ps-left-inner");
    leftInner.append(el("span", "ps-title", "Personal Settings"), menu);
    const left = el("div", "ps-left");
    left.append(leftInner);

    const cards = el("div", "ps-cards");
    for (const section of SECTIONS) {
      const card = el("div", "ns-card ps-card");
      const title = el("div", "ps-card-title");
      title.append(icon(`${ACER}/personal/${section.icon}.svg`), el("span", "", section.title));
      const head = el("div", "ps-card-head");
      head.append(title, el("hr", "ps-rule"));
      card.append(head, ...section.build(page));
      cards.append(card);
      page.cards.set(section.id, card);
    }
    const rightInner = el("div", "ps-right-inner");
    rightInner.append(el("span", "ps-title ps-title-narrow", "Personal Settings"), cards);
    const right = el("div", "ps-right");
    right.append(rightInner);

    row.append(left, right);
    content.append(row);
    page.render();
    page.scroller.append(content);

    page.scroller.addEventListener("scroll", () => {
      clearTimeout(page.spyTimer);
      page.spyTimer = setTimeout(page.spy, SPY_DELAY);
    });
    content.addEventListener("wheel", (event) => {
      page.target = null;
      const { scrollTop, scrollHeight, clientHeight } = page.scroller;
      if (event.deltaY > 0 && scrollHeight - clientHeight - scrollTop <= 1) page.mark(SECTIONS.at(-1).id);
    }, { passive: true });

    // The Lighting page's "Backlight off after 30 seconds" link lands on the Keyboard card.
    const focus = SECTIONS.find((section) => section.id === options?.focus)?.id;
    page.mark(focus ?? SECTIONS[0].id);
    if (focus) page.scrollTo(focus, true);
  }

  function createPage(scroller) {
    const page = {
      scroller,
      values: null,
      usbLimit: 30,
      menuItems: new Map(),
      cards: new Map(),
      renderers: [],
      marked: null,
      target: null, // the clicked section, kept marked when its scroll settles
      lastTop: 0,
      spyTimer: 0,
      backlightTimer: 0,
      writes: Promise.resolve(),

      render() {
        for (const render of page.renderers) render();
      },

      mark(id) {
        for (const [sectionId, item] of page.menuItems) item.classList.toggle("active", sectionId === id);
        page.marked = id;
      },

      // Menu click: smooth scroll (instant when entering the page) to 60 px above the card.
      scrollTo(id, instant = false) {
        const card = page.cards.get(id);
        const max = scroller.scrollHeight - scroller.clientHeight;
        const top = scroller.scrollTop + card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - SCROLL_MARGIN;
        page.target = Math.abs(Math.min(Math.max(top, 0), max) - scroller.scrollTop) >= 1 ? id : null;
        page.mark(id);
        card.scrollIntoView({ behavior: instant ? "instant" : "smooth", block: "start" });
      },

      // Scroll spy: the fully visible section (75 px may hang below); with several, the last one when scrolling
      // down and the first one when scrolling up.
      spy() {
        const view = scroller.getBoundingClientRect();
        const top = scroller.scrollTop;
        const visible = SECTIONS.map((section) => section.id).filter((id) => {
          const box = page.cards.get(id).getBoundingClientRect();
          return box.top >= view.top && box.bottom - 75 <= view.bottom;
        });
        let id = page.marked;
        if (visible.length === 1) id = visible[0];
        else if (visible.length > 1 && top !== page.lastTop) id = top > page.lastTop ? visible.at(-1) : visible[0];
        if (top === 0) id = SECTIONS[0].id;
        if (page.target) {
          id = page.target;
          page.target = null;
        }
        page.lastTop = top;
        page.mark(id);
      },

      usbOn: () => USB_LIMITS.includes(page.values.usb_charging),

      set(name, value) {
        if (page.values[name] === value) return;
        page.values[name] = value;
        page.render();
        page.write(name, value);
      },

      setUsbLimit(limit) {
        page.usbLimit = limit;
        window.nitro.settings.set(USB_LIMIT_KEY, limit);
        page.set("usb_charging", limit);
      },

      // Writes go out one at a time; a refused write puts back what the driver really has (NitroSense shows no
      // errors here either).
      write(name, value) {
        page.writes = page.writes.then(() => window.nitro.personal.set(name, value)).catch(async (error) => {
          console.error(`Personal Settings: writing ${name} failed`, error);
          const values = await window.nitro.personal.read().catch(() => null);
          if (values && current === page) {
            Object.assign(page.values, values);
            page.render();
          }
        });
      },

      flushBacklight() {
        if (!page.backlightTimer) return;
        clearTimeout(page.backlightTimer);
        page.backlightTimer = 0;
        page.write("backlight_timeout", page.values.backlight_timeout);
      },
    };
    return page;
  }

  async function load(page, options) {
    const [values, savedLimit] = await Promise.all([
      window.nitro.personal.read().catch(() => ({})),
      window.nitro.settings.get(USB_LIMIT_KEY).catch(() => null),
    ]);
    if (current !== page) return;
    page.values = Object.fromEntries(
      ["battery_limiter", "usb_charging", "lcd_override", "backlight_timeout", "boot_animation_sound", "gpu_mode"]
        .map((name) => [name, values[name] ?? null]),
    );
    // Turning the charger off forgets its limit in the EC, so the app remembers the last one (NitroSense's 30 %).
    if (USB_LIMITS.includes(savedLimit)) page.usbLimit = savedLimit;
    if (page.usbOn() && page.values.usb_charging !== page.usbLimit) {
      page.usbLimit = page.values.usb_charging;
      window.nitro.settings.set(USB_LIMIT_KEY, page.usbLimit);
    }
    build(page, options);
  }

  window.NitroPages = window.NitroPages || {};
  window.NitroPages["Personal Settings"] = {
    mount(container, options) {
      const scroller = el("div", "ps-scroll");
      container.replaceChildren(scroller);
      current = createPage(scroller);
      load(current, options).catch((error) => console.error("Personal Settings failed to load", error));
    },
    unmount() {
      if (!current) return;
      clearTimeout(current.spyTimer);
      current.flushBacklight();
      current = null;
    },
  };
})();
