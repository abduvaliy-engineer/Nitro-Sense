// Scenario → Pulsar Lighting (NitroSense app-lighting and app-area-lighting-control): the Global effect
// page with its Area info panel, and Area Lighting Control for the four keyboard zones.
(() => {
  const ACER = "../assets/acer";
  const scenario = window.NitroScenario;
  const lighting = window.NitroLighting;
  const AREA_TUTORIAL_KEY = "tutorial.areaPage";
  const ZONES = [0, 1, 2, 3];

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

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const active = () => scenario.state?.profiles[scenario.state.active]?.lighting ?? null;

  function change(mutate) {
    const next = clone(active());
    mutate(next);
    scenario.setLighting(next).catch((error) => console.error("lighting change failed", error));
  }

  function pill(label, ariaLabel, onClick) {
    const button = labelled("button", "pill-btn w156", ariaLabel, label);
    button.addEventListener("click", onClick);
    return button;
  }

  function footer(buttons) {
    const bar = el("div", "ns-dialog-footer");
    bar.append(...buttons);
    return bar;
  }

  // ---------- shared pieces ----------

  function brightnessRow(className, onChange) {
    const row = el("div", `lt-brightness ${className}`);
    const slot = el("div", "lt-brightness-slider");
    const slider = window.NitroSlider.create({ min: 1, max: 5, step: 1, value: 5, scale: [1, 5], onChange });
    slot.append(slider.root);
    const darker = el("div", "lt-brightness-icon");
    darker.append(icon(`${ACER}/light/light_brightness_darker.svg`));
    const lighter = el("div", "lt-brightness-icon");
    lighter.append(icon(`${ACER}/light/light_brightness_lighter.svg`));
    row.append(darker, slot, lighter);
    return {
      root: row,
      set(value) {
        slider.setValue(value);
        slider.root.classList.toggle("min-thumb", value <= 1);
        slider.root.setAttribute("aria-label", `Brightness slider bar level ${value}`);
      },
    };
  }

  function resetDialog() {
    window.NitroDialog.open({
      size: "468x200",
      title: "Reset to Default",
      build(body, close) {
        const content = el("div", "scn-dialog-content lt-reset-content");
        content.append(el("span", "scn-dialog-text",
          "The detailed settings of backlit color and all effects will restore to Default. Are you sure you want to reset the lighting effects?"));
        const reset = pill("Reset", "confirm", () => {
          close();
          scenario.resetLighting().catch((error) => console.error("lighting reset failed", error));
        });
        body.append(content, footer([pill("Cancel", "close", close), reset]));
      },
    });
  }

  function selectLedDialog() {
    window.NitroDialog.open({
      size: "468x468",
      title: "Select Multiple LED",
      build(body, close) {
        const content = el("div", "scn-dialog-content lt-led-content");
        const art = el("div", "lt-led-art");
        art.append(icon(`${ACER}/dialog/dialog_tutorial_selectled_zone.svg`));
        const lines = el("div", "lt-led-lines");
        for (const text of ["Click \"Select zone\" button to select preset LED group.",
          "Press and hold the Ctrl key, and then click to select each zone."]) {
          const row = el("div", "lt-led-line");
          row.append(icon(`${ACER}/dialog/dialog_item.svg`), el("span", "", text));
          lines.append(row);
        }
        content.append(art, lines);
        body.append(content, footer([pill("Close", "close", close)]));
      },
    });
  }

  // The 4-zone keyboard art: Acer's SVG inlined so each zone's gradient stops can take its color.
  let keyboardSvg = null;
  function loadKeyboardSvg() {
    keyboardSvg ??= new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", `${ACER}/light/light_kbzone.svg`);
      request.onload = () => resolve(request.responseText.replaceAll("linear-gradient", "lt-kbzone-gradient"));
      request.onerror = reject;
      request.send();
    });
    return keyboardSvg;
  }

  // ---------- Global page ----------

  function globalPage(container, { openArea }) {
    const root = el("div", "lt-page");
    const inner = el("div", "lt-inner");
    const row = el("div", "lt-row");

    const card = el("div", "ns-card lt-main");
    const toggle = el("div", "lt-toggle");
    const toggles = {};
    for (const [mode, label] of [["global", "Global"], ["area", "Area"]]) {
      const button = labelled("button", "lt-toggle-btn", mode);
      button.append(el("p", "", label));
      button.addEventListener("click", () => change((next) => { next.mode = mode; }));
      toggles[mode] = button;
      toggle.append(button);
    }

    const panel = el("div", "lt-global");
    const brightnessWrap = el("div", "lt-brightness-wrap");
    const brightness = brightnessRow("", (value) => change((next) => { next.global.brightness = value; }));
    brightnessWrap.append(brightness.root);

    const body = el("div", "lt-global-body");
    const effects = el("div", "lt-effects");
    const head = el("div", "lt-effects-head");
    const selectLabel = el("p", "lt-select-label", "Select Effect");
    head.append(selectLabel);

    const selectEffect = (effect) => change((next) => { next.global.effect = effect; });

    // Below 785 px a dropdown replaces the grid.
    const dropdownBox = el("div", "lt-effect-dropdown-box");
    const dropdown = labelled("button", "wi-dropdown lt-dropdown", "effect dropdown menu");
    const dropdownText = el("span", "wi-dropdown-text");
    dropdown.append(dropdownText, el("div", "wi-dropdown-arrow"));
    dropdown.addEventListener("click", () => {
      const current = active()?.global.effect;
      dropdown.classList.add("open");
      window.NitroMenu.open(dropdown, lighting.EFFECTS.map((effect) => ({
        label: lighting.name(effect),
        active: effect === current,
        onSelect: () => selectEffect(effect),
      })), { onClose: () => dropdown.classList.remove("open") });
    });
    dropdownBox.append(dropdown);

    const grid = el("div", "lt-effect-grid");
    const effectButtons = {};
    for (const effect of lighting.EFFECTS) {
      const button = labelled("button", "lt-effect", `light effect ${effect}`);
      const image = el("img");
      image.alt = "";
      const name = el("span");
      button.append(image, name);
      button.addEventListener("click", () => selectEffect(effect));
      effectButtons[effect] = { button, image, name };
      grid.append(button);
    }
    effects.append(head, dropdownBox, grid);

    const colorColumn = el("div", "lt-color-column");
    const color = window.NitroColorPanel.create({
      variant: "global",
      onColor: (hex) => hex !== active()?.global.color && change((next) => { next.global.color = hex; }),
      onSpeed: (value) => value !== active()?.global.speed && change((next) => { next.global.speed = value; }),
      onDirection: (value) => value !== active()?.global.direction && change((next) => { next.global.direction = value; }),
    });
    colorColumn.append(color.root);
    body.append(effects, colorColumn);
    panel.append(brightnessWrap, body);

    const areaInfo = el("div", "lt-area-info");
    const infoText = el("div", "lt-area-info-text");
    infoText.append(el("span", "", "To customize the lighting effect of your unique style for each LED zones."));
    const goRow = el("div", "lt-area-info-go");
    const go = labelled("button", "pill-btn w260", "switch to area control");
    go.append(el("p", "", "To Area Control"));
    go.addEventListener("click", openArea);
    goRow.append(go);
    areaInfo.append(infoText, goRow);

    card.append(el("p", "lt-title", "Lighting Control"), toggle, panel, areaInfo);

    const side = el("div", "lt-side");
    const linkCard = el("div", "ns-card lt-side-card");
    const linkRow = el("div", "lt-link-row");
    const link = el("button", "lt-link");
    link.append(el("span", "", "Backlight off after 30 seconds"), icon(`${ACER}/light/ic_textlink_arrow.svg`));
    link.addEventListener("click", () => window.NitroApp?.selectTab("Personal Settings"));
    linkRow.append(link);
    linkCard.append(linkRow);
    const resetCard = el("div", "ns-card lt-side-card");
    const reset = labelled("button", "lt-reset", "restore");
    reset.append(el("span", "", "Reset"));
    reset.addEventListener("click", resetDialog);
    resetCard.append(el("p", "lt-reset-label", "Reset lighting effect settings"), reset);
    side.append(linkCard, resetCard);

    row.append(card, side);
    inner.append(row);
    root.append(inner);
    container.replaceChildren(root);

    return {
      name: "global",
      render() {
        const current = active();
        if (!current) return;
        const { global } = current;
        const isArea = current.mode === "area";
        toggles.global.classList.toggle("selected", !isArea);
        toggles.area.classList.toggle("selected", isArea);
        panel.hidden = isArea;
        areaInfo.hidden = !isArea;

        const off = global.brightness <= 1;
        brightness.set(global.brightness);
        selectLabel.classList.toggle("dim", off);
        dropdown.disabled = off;
        dropdownText.textContent = lighting.name(global.effect);
        for (const [effect, { button, image, name }] of Object.entries(effectButtons)) {
          // 2025 models rename three effects; the model is known once NitroLighting has loaded.
          image.src = `${ACER}/light/light_effect_${lighting.icon(effect)}.svg`;
          name.textContent = lighting.name(effect);
          button.classList.toggle("selected", effect === global.effect);
          button.disabled = off;
        }
        color.setState({ locked: lighting.colorLocked(global.effect), disabled: off });
        color.setColor(global.color);
        color.setSpeed(global.speed, lighting.hasSpeed(global.effect));
        color.setDirection(global.direction, lighting.hasDirection(global.effect));
      },
      destroy() {
        color.destroy();
        window.NitroMenu.close();
      },
    };
  }

  // ---------- Area Lighting Control ----------

  function areaPage(container) {
    const root = el("div", "lt-area");
    const inner = el("div", "lt-area-inner");
    const card = el("div", "ns-card lt-area-card");

    const top = el("div", "lt-area-top");
    const brightness = brightnessRow("start", (value) => {
      if (value <= 1) selected.clear();
      change((next) => { next.keyboard.brightness = value; });
    });
    top.append(brightness.root);

    const body = el("div", "lt-area-body");
    const left = el("div", "lt-area-left");
    const leftInner = el("div", "lt-area-left-inner");

    const selected = new Set();
    const off = () => (active()?.keyboard.brightness ?? 5) <= 1;

    // zone menu: dropdown (≥785) or checkbox list (<785), then the (i) button
    const zoneMenu = el("div", "lt-zone-menu");
    const wide = el("div", "lt-zone-wide");
    const dropdown = labelled("button", "wi-dropdown lt-dropdown", "Select Zone");
    dropdown.append(el("span", "wi-dropdown-text", "Select Zone"), el("div", "wi-dropdown-arrow"));
    dropdown.addEventListener("click", openZoneMenu);
    wide.append(dropdown);

    const narrow = el("div", "lt-zone-narrow");
    narrow.append(el("p", "lt-zone-narrow-title", "Select Zone"));
    const narrowBoxes = ZONES.map((zone) => {
      const line = el("div", "lt-zone-narrow-row");
      const box = labelled("button", "ns-checkbox", `Zone ${zone + 1}`);
      box.append(icon(`${ACER}/widget/checkbox_v.svg`));
      box.addEventListener("click", () => toggleZone(zone));
      line.append(box, el("p", "", `${zone + 1}. Zone ${zone + 1}`));
      narrow.append(line);
      return box;
    });

    const zoneInfo = labelled("button", "lt-zone-info custom-btn", "select_LED_info");
    zoneInfo.append(icon(`${ACER}/scenario/ic_infomation.svg`));
    zoneInfo.addEventListener("click", selectLedDialog);
    zoneMenu.append(wide, narrow, zoneInfo);

    // keyboard art and zone buttons
    const keyboardArea = el("div", "lt-kb-area");
    const keyboardWrap = el("div", "lt-kb-wrap");
    const keyboard = el("div", "lt-kb");
    const keyboardInner = el("div", "lt-kb-inner");
    const art = el("div", "lt-kb-art");
    const zoneRow = el("div", "lt-zone-row");
    const zoneItems = ZONES.map((zone) => {
      const item = el("div", "lt-zone");
      const bar = el("div", "lt-zone-bar");
      const button = labelled("button", "lt-zone-btn", `number_${zone + 1}`, String(zone + 1));
      button.addEventListener("click", (event) => {
        // Without Ctrl a click selects only this zone (or clears it when it was the selection).
        const wasSelected = selected.has(zone);
        if (!event.ctrlKey) selected.clear();
        if (wasSelected && event.ctrlKey) selected.delete(zone);
        else if (!wasSelected) selected.add(zone);
        render();
      });
      item.append(bar, button);
      zoneRow.append(item);
      return { bar, button };
    });
    keyboard.addEventListener("pointerup", (event) => {
      if (event.target.closest("button")) return;
      selected.clear();
      render();
    });
    keyboardInner.append(art, zoneRow);
    keyboard.append(keyboardInner);
    keyboardWrap.append(keyboard);
    keyboardArea.append(keyboardWrap);
    leftInner.append(zoneMenu, keyboardArea);
    left.append(leftInner);

    const colorColumn = el("div", "lt-area-color");
    const color = window.NitroColorPanel.create({
      variant: "area",
      onColor: (hex) => {
        if (!selected.size) return;
        change((next) => {
          next.mode = "area";
          for (const zone of selected) next.keyboard.zones[zone] = hex;
        });
      },
    });
    colorColumn.append(color.root);
    body.append(left, colorColumn);
    card.append(top, body);
    inner.append(card);
    root.append(inner);
    container.replaceChildren(root);

    let stops = null;
    loadKeyboardSvg().then((svg) => {
      art.innerHTML = svg;
      stops = [...art.querySelectorAll("stop")];
      render();
    }).catch((error) => console.error("keyboard art failed to load", error));

    function toggleZone(zone) {
      if (selected.has(zone)) selected.delete(zone);
      else selected.add(zone);
      render();
    }

    // The zone dropdown stays open while zones are ticked; "All" follows the four zones.
    function openZoneMenu() {
      if (off()) return;
      const box = dropdown.getBoundingClientRect();
      const layer = el("div", "ns-menu-layer");
      const menu = el("div", "ns-menu lt-zone-panel");
      menu.style.left = `${box.left}px`;
      menu.style.top = `${box.bottom + 4}px`;
      menu.style.width = `${box.width}px`;
      const boxes = [];
      for (const zone of [-1, ...ZONES]) {
        const item = el("div", "ns-menu-item");
        const button = el("button", "lt-zone-item");
        const check = el("div", "ns-checkbox");
        check.append(icon(`${ACER}/widget/checkbox_v.svg`));
        button.append(check, el("p", "", zone < 0 ? "All" : `${zone + 1}. Zone ${zone + 1}`));
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          if (zone >= 0) toggleZone(zone);
          else {
            const all = selected.size === ZONES.length;
            ZONES.forEach((z) => (all ? selected.delete(z) : selected.add(z)));
            render();
          }
          paint();
        });
        item.append(button);
        menu.append(item);
        boxes.push({ zone, check });
      }
      const paint = () => boxes.forEach(({ zone, check }) => check.classList.toggle("checked",
        zone < 0 ? selected.size === ZONES.length : selected.has(zone)));
      const close = () => {
        layer.remove();
        dropdown.classList.remove("open");
        removeEventListener("resize", close);
      };
      layer.addEventListener("pointerdown", (event) => event.target === layer && close());
      addEventListener("resize", close);
      layer.append(menu);
      document.body.append(layer);
      dropdown.classList.add("open");
      paint();
    }

    function render() {
      const current = active();
      if (!current) return;
      const { keyboard: keys } = current;
      const dark = keys.brightness <= 1;
      if (dark) selected.clear();
      brightness.set(keys.brightness);

      art.classList.toggle("dim", dark);
      stops?.forEach((stop, i) => stop.setAttribute("stop-color", keys.zones[Math.floor(i / 2)] ?? "#000000"));
      zoneItems.forEach(({ bar, button }, zone) => {
        button.classList.toggle("selected", selected.has(zone));
        button.disabled = dark;
        bar.classList.toggle("on", selected.has(zone) && !dark);
      });
      narrowBoxes.forEach((box, zone) => {
        box.classList.toggle("checked", selected.has(zone));
        box.disabled = dark;
      });
      narrow.classList.toggle("dim", dark);
      dropdown.disabled = dark;

      const colors = [...selected].map((zone) => keys.zones[zone]);
      color.setState({ locked: false, disabled: dark || !colors.length });
      if (colors.length) color.setColor(colors.every((c) => c === colors[0]) ? colors[0] : null);
    }

    // Opening the page shows the zone colors on the keyboard; Zone 1 starts selected.
    if (!off()) selected.add(0);
    change((next) => { next.mode = "area"; });
    window.nitro.settings.get(AREA_TUTORIAL_KEY).then((seen) => {
      if (seen) return;
      window.nitro.settings.set(AREA_TUTORIAL_KEY, true);
      selectLedDialog();
    });

    return {
      name: "area",
      render,
      destroy() {
        color.destroy();
        document.querySelector(".lt-zone-panel")?.parentElement.remove();
      },
    };
  }

  // ---------- page ----------

  let current = null;

  window.NitroScenarioPages = window.NitroScenarioPages || {};
  window.NitroScenarioPages.Pulsar_Lighting = {
    mount(container) {
      let view = null;
      const show = (name) => {
        view?.destroy();
        if (name === "area") {
          window.NitroScenarioFrame.showBack("Area Lighting Control", "back to lighting global page", () => show("global"));
          view = areaPage(container);
        } else {
          window.NitroScenarioFrame.showTabs();
          view = globalPage(container, { openArea: () => show("area") });
        }
        view.render();
      };
      show("global");
      lighting.load().then(() => current && view.render());
      // A profile switched elsewhere: the Area page goes back to Global when the new profile is Global.
      const unsubscribe = scenario.subscribe((state) => {
        if (view.name === "area" && state.profiles[state.active]?.lighting.mode !== "area") show("global");
        else view.render();
      });
      scenario.load();
      current = {
        destroy() {
          unsubscribe();
          view.destroy();
          window.NitroScenarioFrame.showTabs();
        },
      };
    },
    unmount() {
      current?.destroy();
      current = null;
    },
  };
})();
