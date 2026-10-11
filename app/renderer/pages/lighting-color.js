// NitroSense app-color-pick-panel: HSV wheel with a brightness range, basic and favourite swatches,
// RGB fields and the eyedropper. The Global variant adds Speed and Direction; Area adds the "none" swatch.
(() => {
  const ACER = "../assets/acer";
  const BASIC = ["#00aec7", "#3cf03c", "#ff2828", "#ffa000", "#a000ff"];
  const FAVORITES_KEY = "lighting.favorites";
  const FAVORITES_MAX = 9;
  const SIZE = 126;
  const RADIUS = SIZE / 2;
  const EMIT_DELAY = 100;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, ariaLabel) {
    const node = el("button", className);
    node.setAttribute("aria-label", ariaLabel);
    return node;
  }

  const toRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff];
  };
  const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

  function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
  }

  function rgbToHsv([r, g, b]) {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    return [h < 0 ? h + 360 : h, max ? d / max : 0, max];
  }

  // Wheel pixel at (x, y): hue from the angle (red at 3 o'clock, clockwise), saturation from the radius.
  function wheelHsv(x, y, v) {
    const dx = x - RADIUS;
    const dy = y - RADIUS;
    const sat = Math.hypot(dx, dy) / RADIUS;
    if (sat > 1) return null;
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
    return [hue < 0 ? hue + 360 : hue, sat, v];
  }

  // NitroSense RGB field filter: "0" + digit keeps only that digit; digits only; clamp to 255.
  function cleanChannel(text) {
    if (/^0[1-9]/.test(text)) text = text[1];
    const value = parseInt(text.replace(/[^\d.]/g, "").replace(/\..*/, ""), 10);
    return Number.isNaN(value) ? 0 : Math.min(255, value);
  }

  let favorites = null;
  const loadFavorites = () => (favorites ??= window.nitro.settings.get(FAVORITES_KEY)
    .then((list) => (Array.isArray(list) ? list.filter((hex) => /^#[0-9a-f]{6}$/.test(hex)) : []))
    .catch(() => []));

  // variant "global" | "area"; onColor(hex) fires 100 ms after the last change (eyedropper at once).
  function create({ variant, onColor, onSpeed, onDirection }) {
    const root = el("div", `lt-color lt-color-${variant}`);
    root.addEventListener("pointerdown", (event) => event.stopPropagation());

    // header: "Color", eyedropper, (i)
    const header = el("div", "lt-color-header");
    const title = el("p", "lt-color-title", "Color");
    const tools = el("div", "lt-color-tools");
    const dropper = button("lt-dropper custom-btn", "pick color with dropper");
    dropper.hidden = true;
    const info = button("lt-color-info custom-btn", "open color picker introduction");
    const infoIcon = el("img");
    infoIcon.src = `${ACER}/scenario/ic_infomation.svg`;
    infoIcon.alt = "";
    info.append(infoIcon);
    tools.append(dropper, info);
    header.append(title, tools);

    const popover = el("div", "lt-color-popover");
    const popoverBody = el("div", "lt-color-popover-body");
    popoverBody.append(
      el("p", "", "1. Click \"+\" to add your favorite color"),
      el("div", "lt-color-popover-gap"),
      el("p", "", "2. To remove favorites, just right click on the color, and then click \"Delete\""),
    );
    popover.append(popoverBody);
    popover.hidden = true;
    const closePopover = () => { popover.hidden = true; };
    info.addEventListener("click", (event) => {
      event.stopPropagation();
      popover.hidden = !popover.hidden;
    });
    document.addEventListener("click", closePopover);

    // wheel and brightness range
    const wheelRow = el("div", "lt-wheel-row");
    const circle = el("div", "lt-circle");
    const disc = el("div", "lt-disc");
    const canvas = el("canvas", "lt-wheel");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    const autoLabel = el("div", "lt-auto");
    autoLabel.append(el("span", "", "Auto"));
    disc.append(canvas, autoLabel);
    const rangeBox = el("div", "lt-range-box");
    const range = el("input", "lt-range");
    range.type = "range";
    range.min = "0";
    range.max = "1";
    range.step = "0.01";
    range.setAttribute("aria-label", "color brightness");
    rangeBox.append(range);
    circle.append(disc, rangeBox);

    // swatches, favourites, current color and RGB
    const swatches = el("div", "lt-swatches");
    const none = variant === "area" ? button("lt-swatch lt-none", "Select basic color") : null;
    const basicGrid = el("div", "lt-basic");
    const basicButtons = BASIC.map((hex) => {
      const [r, g, b] = toRgb(hex);
      const swatch = button("lt-swatch", `Select basic color r ${r},g ${g},b ${b}`);
      swatch.style.background = `rgb(${r}, ${g}, ${b})`;
      swatch.addEventListener("click", () => pick(hex));
      basicGrid.append(swatch);
      return swatch;
    });
    const favoriteGrid = el("div", "lt-favorites");
    const add = button("lt-add", "add color");
    const rgbRow = el("div", "lt-rgb-row");
    const bar = el("div", "lt-current");
    const fields = el("div", "lt-rgb-fields");
    const inputs = ["R", "G", "B"].map((channel) => {
      const row = el("div", "lt-rgb");
      const box = el("div", "lt-rgb-box");
      const input = el("input");
      input.type = "text";
      input.spellcheck = false;
      input.setAttribute("aria-label", `RGB ${channel}`);
      box.append(input);
      row.append(el("label", "", channel), box);
      fields.append(row);
      return input;
    });
    rgbRow.append(bar, fields);
    if (none) swatches.append(none);
    swatches.append(basicGrid, favoriteGrid, rgbRow);
    wheelRow.append(circle, swatches);
    root.append(header, popover, wheelRow);

    // speed and direction (Global)
    let speed = null;
    let speedBlock = null;
    let directionBlock = null;
    const directionButtons = {};
    if (variant === "global") {
      const extras = el("div", "lt-extras");
      speedBlock = el("div", "lt-speed");
      speed = window.NitroSlider.create({ min: 1, max: 5, step: 1, value: 3, scale: [1, 5], ariaLabel: "speed", onChange: (v) => onSpeed?.(v) });
      speedBlock.append(el("p", "lt-label", "Speed"), speed.root);
      directionBlock = el("div", "lt-direction");
      const buttons = el("div", "lt-direction-buttons");
      for (const [value, side] of [[2, "left"], [1, "right"]]) {
        const direction = button(`lt-direction-btn ${side}`, `Effect direction ${side}`);
        direction.addEventListener("click", () => onDirection?.(value));
        directionButtons[value] = direction;
        buttons.append(direction);
      }
      directionBlock.append(el("p", "lt-label", "Direction"), buttons);
      extras.append(speedBlock, directionBlock);
      root.append(extras);
    }

    // ---------- state ----------

    let hsv = [0, 0, 1];
    let hex = "#ffffff";
    let mixed = false;
    let locked = false;
    let disabled = false;
    let emitTimer = null;

    function drawWheel() {
      const image = ctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const point = wheelHsv(x, y, hsv[2]);
          if (!point) continue;
          const i = (y * SIZE + x) * 4;
          const rgb = hsvToRgb(...point);
          image.data[i] = rgb[0] * 255;
          image.data[i + 1] = rgb[1] * 255;
          image.data[i + 2] = rgb[2] * 255;
          image.data[i + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      if (locked || mixed) return;
      const angle = (hsv[0] * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(RADIUS * hsv[1] * Math.cos(angle) + RADIUS, RADIUS * hsv[1] * Math.sin(angle) + RADIUS, 4, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // The range shows the hue darkening to black; NitroSense feeds the HSV saturation into hsl().
    function paintRange() {
      range.style.background = mixed ? "rgb(125, 125, 125)" : `linear-gradient(0.25turn, ${
        [0, 10, 20, 30, 40, 50, 60, 70].map((l) => `hsl(${hsv[0]} ${hsv[1] * 100}% ${l}%)`).join(", ")})`;
    }

    function render({ fields: updateFields = true } = {}) {
      drawWheel();
      paintRange();
      range.value = String(hsv[2]);
      bar.style.background = mixed ? "rgb(125, 125, 125)" : hex;
      if (updateFields) toRgb(hex).forEach((v, i) => { inputs[i].value = mixed ? "--" : String(v); });
      add.disabled = locked || mixed || disabled;
    }

    function changed() {
      bar.style.background = hex;
      clearTimeout(emitTimer);
      emitTimer = setTimeout(() => {
        emitTimer = null;
        onColor?.(hex);
      }, EMIT_DELAY);
    }

    function pick(next) {
      if (locked || disabled) return;
      mixed = false;
      hex = next;
      hsv = rgbToHsv(toRgb(hex));
      render();
      changed();
    }

    // wheel: read the color under the pointer while it is down
    function pickAt(event) {
      const box = canvas.getBoundingClientRect();
      const x = Math.floor(event.clientX - box.left - canvas.clientLeft);
      const y = Math.floor(event.clientY - box.top - canvas.clientTop);
      const point = wheelHsv(x, y, hsv[2]);
      if (!point) return;
      mixed = false;
      hsv = point;
      hex = toHex(hsvToRgb(...point).map((v) => Math.round(v * 255)));
      render();
      changed();
    }

    canvas.addEventListener("pointerdown", (event) => {
      if (locked || disabled || hsv[2] === 0 || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      pickAt(event);
      const move = (e) => pickAt(e);
      const end = () => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", end);
        canvas.removeEventListener("pointercancel", end);
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
    });

    range.addEventListener("input", () => {
      hsv = [hsv[0], hsv[1], Number(range.value)];
      mixed = false;
      hex = toHex(hsvToRgb(...hsv).map((v) => Math.ceil(v * 255)));
      drawWheel();
      bar.style.background = hex;
      toRgb(hex).forEach((v, i) => { inputs[i].value = String(v); });
      changed();
    });

    inputs.forEach((input) => input.addEventListener("input", () => {
      const values = inputs.map((field) => cleanChannel(field.value === "--" ? "0" : field.value));
      input.value = String(values[inputs.indexOf(input)]);
      mixed = false;
      hex = toHex(values);
      hsv = rgbToHsv(values);
      render({ fields: false });
      changed();
    }));

    none?.addEventListener("click", () => pick("#000000"));

    // favourites
    let favoriteList = [];
    function renderFavorites() {
      favoriteGrid.replaceChildren(add, ...favoriteList.map((color) => {
        const [r, g, b] = toRgb(color);
        const swatch = button("lt-swatch", `Select recent color r ${r},g ${g},b ${b}`);
        swatch.style.background = color;
        swatch.disabled = locked || disabled;
        swatch.addEventListener("click", () => pick(color));
        swatch.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          if (!swatch.disabled) deleteMenu(event, color);
        });
        return swatch;
      }));
    }

    function saveFavorites(next) {
      favoriteList = next;
      favorites = Promise.resolve(next);
      window.nitro.settings.set(FAVORITES_KEY, next);
      renderFavorites();
    }

    add.addEventListener("mouseup", () => {
      if (add.disabled || BASIC.includes(hex)) return;
      saveFavorites([hex, ...favoriteList.filter((color) => color !== hex)].slice(0, FAVORITES_MAX));
    });

    function deleteMenu(event, color) {
      const layer = el("div", "ns-menu-layer");
      const remove = button("lt-delete", "delete color");
      remove.textContent = "Delete";
      remove.style.left = `${event.clientX + 4}px`;
      remove.style.top = `${event.clientY + 16}px`;
      remove.addEventListener("click", () => {
        layer.remove();
        saveFavorites(favoriteList.filter((c) => c !== color));
      });
      layer.addEventListener("pointerdown", (e) => e.target === layer && layer.remove());
      layer.addEventListener("contextmenu", (e) => { e.preventDefault(); layer.remove(); });
      layer.append(remove);
      document.body.append(layer);
    }

    loadFavorites().then((list) => {
      favoriteList = list;
      renderFavorites();
    });

    // eyedropper (hyprpicker on Hyprland)
    window.nitro.lighting.info().then((result) => { dropper.hidden = !result?.picker; });
    dropper.addEventListener("click", async () => {
      const color = await window.nitro.lighting.pickColor().catch(() => null);
      if (!color || locked || disabled) return;
      mixed = false;
      hex = color;
      hsv = rgbToHsv(toRgb(hex));
      render();
      clearTimeout(emitTimer);
      emitTimer = null;
      onColor?.(hex);
    });

    function applyState() {
      root.classList.toggle("locked", locked);
      root.classList.toggle("disabled", disabled);
      dropper.disabled = locked || disabled;
      info.disabled = locked || disabled;
      range.disabled = locked || disabled || mixed;
      for (const input of inputs) input.disabled = locked || disabled;
      for (const swatch of basicButtons) swatch.disabled = locked || disabled;
      if (none) none.disabled = disabled;
      speed?.setDisabled(disabled);
      for (const direction of Object.values(directionButtons)) direction.disabled = disabled;
      if (locked || disabled) closePopover();
      renderFavorites();
      render();
    }

    applyState();

    return {
      root,
      // hex, or null when the selected zones have different colors; an edit still waiting to be sent wins
      setColor(next) {
        if (emitTimer) return;
        mixed = next === null;
        if (!mixed) {
          hex = next;
          hsv = rgbToHsv(toRgb(hex));
        }
        render();
      },
      setState(next) {
        locked = Boolean(next.locked);
        disabled = Boolean(next.disabled);
        applyState();
      },
      setSpeed(value, visible) {
        if (!speedBlock) return;
        speedBlock.hidden = !visible;
        speed.setValue(value);
        speedBlock.parentElement.hidden = speedBlock.hidden && directionBlock.hidden;
      },
      setDirection(value, visible) {
        if (!directionBlock) return;
        directionBlock.hidden = !visible;
        directionButtons[1].classList.toggle("selected", value !== 2);
        directionButtons[2].classList.toggle("selected", value === 2);
        directionBlock.parentElement.hidden = speedBlock.hidden && directionBlock.hidden;
      },
      destroy() {
        clearTimeout(emitTimer);
        document.removeEventListener("click", closePopover);
      },
    };
  }

  window.NitroColorPanel = { create };
})();
