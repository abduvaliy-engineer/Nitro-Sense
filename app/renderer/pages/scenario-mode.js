// Scenario → Mode page (NitroSense app-mode-nitro): mode cards, GPU/CPU needle gauges, mode introduction.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ACER = "../assets/acer";
  const EASE_MS = 350;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  // Clock gauge: arc and needle follow clock / max clock (2.7° per %), starting at 6 o'clock.
  // NitroSense jumps between samples; we ease the sweep and settle on its exact (floored) position.
  function clockGauge(id, title, { idleLine = false } = {}) {
    const root = el("div", "mode-gauge-block");

    const gradient = svg("linearGradient", { id: `${id}-circle` });
    for (const [offset, color] of [["0%", "#FF001E"], ["25%", "#FF001E"], ["100%", "#FFA000"]]) {
      gradient.append(svg("stop", { offset, "stop-color": color }));
    }
    const filter = svg("filter", { id: `mode-${id}-poly` });
    filter.append(
      svg("feOffset", { in: "SourceGraphic", result: "offOut" }),
      svg("feGaussianBlur", { in: "offOut", stdDeviation: "5", result: "blurOut" }),
      svg("feBlend", { in: "SourceGraphic", in2: "blurOut", mode: "normal" }),
    );
    const defs = svg("defs");
    defs.append(gradient, filter);
    const arc = svg("circle", { cx: "90", cy: "90", r: "70", stroke: `url(#${id}-circle)`, filter: `url(#mode-${id}-poly)` });
    const ring = svg("svg", { class: "mode-circle-svg", width: "180", height: "180" });
    ring.append(defs, arc);

    const needle = el("img", "mode-needle");
    needle.src = `${ACER}/mode/mode_needle.svg`;
    needle.alt = "";
    const needleBox = el("div", "mode-needle-box");
    needleBox.append(needle);
    const circle = el("div", "mode-circle");
    circle.append(ring, needleBox);

    const value = el("p", "mode-gauge-value", "--");
    const usage = el("p", "mode-gauge-usage", "--%");
    const text = el("div", "mode-gauge-text");
    text.append(
      el("p", "mode-gauge-title", title),
      el("p", "mode-gauge-label clock", "Core Clock"),
      value,
      el("p", "mode-gauge-unit", "MHz"),
      el("p", "mode-gauge-label usage", "Usage"),
      usage,
    );
    let idleText = null;
    if (idleLine) {
      idleText = el("p", "mode-gauge-idle", "Discrete GPU is idle");
      idleText.hidden = true;
      text.append(idleText);
    }
    root.append(circle, text);

    // shown = { pct, ratio } currently drawn; target = where the sweep is heading.
    let shown = { pct: 0, ratio: 0 };
    let frame = 0;

    function draw({ pct, ratio }) {
      const dash = 3.3 * pct;
      arc.style.strokeDasharray = `${dash}px ${440 - dash}px`;
      needle.style.transform = `rotate(${2.7 * pct}deg)`;
      gradient.setAttribute("gradientTransform", `rotate(${90 * ratio - 45})`);
    }

    function sweepTo(target) {
      cancelAnimationFrame(frame);
      const from = { ...shown };
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / EASE_MS);
        const k = 1 - (1 - t) ** 3;
        shown = { pct: from.pct + (target.pct - from.pct) * k, ratio: from.ratio + (target.ratio - from.ratio) * k };
        draw(shown);
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }

    // NitroSense: the GPU shows "--" only while idle; the CPU shows "--" for a zero reading.
    function update({ frequency, max, usage: load, idle }) {
      if (idleText) idleText.hidden = !idle;
      if (idleLine) {
        value.textContent = idle || frequency == null ? "--" : String(Math.ceil(frequency));
        usage.textContent = idle || load == null ? "--%" : `${Math.ceil(load)}%`;
      } else {
        value.textContent = frequency ? String(Math.ceil(frequency)) : "--";
        usage.textContent = load ? `${Math.ceil(load)}%` : "--%";
      }
      const ratio = !idle && frequency && max > 0 ? frequency / max : 0;
      sweepTo({ pct: Math.floor(ratio * 100), ratio });
    }

    draw(shown);
    return { root, update, destroy: () => cancelAnimationFrame(frame) };
  }

  // ---------- Mode page ----------

  const scenario = window.NitroScenario;
  const AC_MODES = ["quiet", "balanced", "balanced-performance", "performance"];
  const DC_MODES = ["low-power", "balanced"];
  const ICONS = { quiet: "quiet", balanced: "balanced", "balanced-performance": "performance", performance: "turbo", "low-power": "eco" };
  const INTRO = {
    quiet: "Limit fan speeds to keep system noise at a minimum.",
    balanced: "Recommended for standard, everyday use.",
    "balanced-performance": "Intended for gaming or rendering. CPU + GPU overclocked. Fan speed remains throttled.",
    performance: "All-out performance. Overclocks and fan speeds are all maxed.",
    "low-power": "Can be used when running on battery only. Optimizes PC for an extended battery life.",
  };
  // Keyboard color shown for each mode (NitroSense line-nitro-* bars).
  const MODE_COLORS = {
    quiet: "#FFFFFF",
    balanced: "#FF8415",
    "balanced-performance": "#FF0700",
    performance: "#FF00E1",
    "low-power": "#1EFF94",
  };
  const LOW_BATTERY = 40;
  const MODE_KEY_SETTING = "modeKey.cycle";
  const MODE_INTRO_SEEN = "tutorial.modeIntro";

  function icon(src, className) {
    const image = el("img", className);
    image.src = src;
    image.alt = "";
    return image;
  }

  function dialogFooter(close) {
    const bar = el("div", "ns-dialog-footer");
    const button = el("button", "pill-btn w156", "Close");
    button.addEventListener("click", close);
    bar.append(button);
    return bar;
  }

  function modeIntroDialog() {
    window.NitroDialog.open({
      size: "468x468",
      title: "The introduction of Mode",
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        const lead = el("div", "mode-intro-lead");
        lead.append(el("span", "",
          "You can set the system mode in AC power or on battery power. Lighting will show the color effect for a short period of time when changing modes."));
        const columns = el("div", "mode-intro-columns");
        for (const [title, modes] of [["AC Plugged In", AC_MODES], ["On Battery Power", ["low-power", "balanced"]]]) {
          const column = el("div", "mode-intro-column");
          column.append(el("p", "mode-intro-title", title));
          for (const mode of modes) {
            const row = el("div", "mode-intro-row");
            const name = el("div", "mode-intro-name");
            const bar = el("div", "mode-intro-bar");
            bar.style.background = MODE_COLORS[mode];
            name.append(el("span", "", scenario.MODE_NAMES[mode]), bar);
            row.append(icon(`${ACER}/mode/ic_mode_${ICONS[mode]}.svg`, "mode-intro-icon"), name);
            column.append(row);
          }
          columns.append(column);
        }
        content.append(lead, columns);
        body.append(content, dialogFooter(close));
      },
    });
  }

  function modeKeyIntroDialog() {
    window.NitroDialog.open({
      size: "468x468",
      title: "The introduction of Mode Switch Key",
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        const art = el("div", "scn-intro-art");
        art.append(icon(`${ACER}/dialog/dialog_tutorial_modeswitch.svg`));
        const lead = el("div", "mode-key-lead");
        lead.append(el("span", "", "Pressing Mode Switch Key allows you to change the system mode of the current scenario quickly."));
        const section = (title, lines) => {
          const head = el("p", "mode-key-head", title);
          const box = el("div", "mode-key-lines");
          for (const line of lines) box.append(el("span", "", line));
          return [head, box];
        };
        content.append(
          art,
          lead,
          ...section("Mode Cycle Switching", ["AC Plugged In: Quiet > Balanced > Performance > Turbo", "On Battery Power: Balanced > Eco"]),
          ...section("Turbo On/Off", ["Turn Turbo mode on or off with one click.", "*Only supported in AC plugged in."]),
        );
        body.append(content, dialogFooter(close));
      },
    });
  }

  let desiredModeKeyCycle;
  window.nitro.settings.get(MODE_KEY_SETTING).then((value) => {
    if (typeof value === "boolean") desiredModeKeyCycle = value;
  }, () => {});

  let current = null;

  window.NitroScenarioPages = window.NitroScenarioPages || {};
  window.NitroScenarioPages.Mode = {
    mount(container) {
      const root = el("div", "mode-page");
      const layout = el("div", "mode-layout");

      // main card
      const main = el("div", "ns-card mode-main");
      const header = el("div", "mode-header");
      const title = el("p", "mode-title", "AC Plugged In");
      const info = el("button", "mode-info custom-btn");
      info.setAttribute("aria-label", "introduction of mode");
      info.append(icon(`${ACER}/scenario/ic_infomation.svg`));
      info.addEventListener("click", modeIntroDialog);
      header.append(title, info);

      const cards = el("div", "mode-cards");
      const message = el("div", "mode-message");
      const messageText = el("span", "");
      const messageBox = el("div", "mode-message-text");
      messageBox.append(messageText);
      message.append(messageBox);
      message.hidden = true;

      const gauges = el("div", "mode-gauges");
      const gpu = clockGauge("gpu", "GPU", { idleLine: true });
      const cpu = clockGauge("cpu", "CPU");
      gauges.append(gpu.root, el("div", "mode-gauge-divider"), cpu.root);

      const intro = el("div", "mode-intro");
      const introText = el("p", "mode-intro-text", "");
      intro.append(el("p", "mode-intro-heading", "The introduction of Mode"), introText);
      main.append(header, cards, message, gauges, intro);

      // right card: mode switch key behavior (GPU Operating Setting is hidden: no MUX support in linuwu-sense)
      const side = el("div", "ns-card mode-side");
      const keyBox = el("div", "mode-key");
      const keyHead = el("div", "mode-key-row");
      const keyInfo = el("button", "custom-btn");
      keyInfo.setAttribute("aria-label", "introduction of mode switch key behavior");
      keyInfo.append(icon(`${ACER}/scenario/ic_infomation.svg`));
      keyInfo.addEventListener("click", modeKeyIntroDialog);
      const keyInfoBox = el("div", "mode-key-info");
      keyInfoBox.append(keyInfo);
      keyHead.append(el("span", "mode-key-label", "Mode switch key behavior"), keyInfoBox);
      const radios = {};
      const radioRow = (cycle, label, className) => {
        const wrap = el("div", className);
        const button = el("button", "mode-radio");
        button.setAttribute("aria-label", cycle ? "Mode Cycle Switching" : "Turbo On Off");
        const dot = el("div", "ns-radio");
        button.append(dot, el("span", "", label));
        button.addEventListener("click", async () => {
          desiredModeKeyCycle = cycle;
          window.nitro.settings.set(MODE_KEY_SETTING, cycle);
          setRadio(cycle);
          await window.nitro.controls.setModeKeyCycle(cycle).catch((error) => console.error(error));
        });
        wrap.append(button);
        radios[cycle] = dot;
        return wrap;
      };
      keyBox.append(keyHead, radioRow(true, "Mode Cycle Switching", "mode-radio-first"), radioRow(false, "Turbo On/Off", "mode-radio-second"));
      side.append(keyBox);

      function setRadio(cycle) {
        radios[true].classList.toggle("on", cycle === true);
        radios[false].classList.toggle("on", cycle === false);
      }

      layout.append(main, side);
      root.append(layout);
      container.replaceChildren(root);

      let cardButtons = {};
      let cardKey = "";
      let selected = null;

      function renderCards(modes, disabled) {
        const key = modes.join() + "|" + [...disabled].join();
        if (key === cardKey) return;
        cardKey = key;
        cardButtons = {};
        cards.replaceChildren(...modes.map((mode, index) => {
          const wrap = el("div", "mode-card-wrap");
          if (modes.length === 3 && index === 2) wrap.classList.add("span-2");
          const button = el("button", "mode-card");
          const iconBox = el("div", "mode-card-icon");
          iconBox.append(icon(`${ACER}/mode/ic_mode_${ICONS[mode]}.svg`));
          button.append(iconBox, el("p", "", scenario.MODE_NAMES[mode]));
          button.disabled = disabled.has(mode);
          button.addEventListener("click", () => {
            selected = mode;
            markSelected();
            scenario.setMode(mode).catch((error) => console.error("mode change failed", error));
          });
          wrap.append(button);
          cardButtons[mode] = button;
          return wrap;
        }));
        markSelected();
      }

      function markSelected() {
        for (const [mode, button] of Object.entries(cardButtons)) button.classList.toggle("selected", mode === selected);
      }

      current = {
        update(snapshot) {
          const battery = snapshot.power?.ac === false;
          const low = !battery && snapshot.power?.battery != null && snapshot.power.battery < LOW_BATTERY;
          title.textContent = battery ? "On Battery Power" : "AC Plugged In";
          const disabled = new Set(low ? ["balanced-performance", "performance"] : []);
          renderCards(battery ? ["low-power", "balanced"] : AC_MODES, disabled);
          selected = snapshot.profile;
          markSelected();

          const text = battery
            ? "When AC adapter is plugged in, it will display full mode options and restore setting."
            : low ? "Mode switching is available when the battery life is at least 40% capacity." : "";
          messageText.textContent = text;
          message.hidden = !text;
          introText.textContent = INTRO[snapshot.profile] ?? "";

          gpu.update({ frequency: snapshot.gpu.frequency, max: snapshot.gpu.maxFrequency, usage: snapshot.gpu.usage, idle: !snapshot.gpu.active });
          cpu.update({ frequency: snapshot.cpu.frequency, max: snapshot.cpu.maxFrequency, usage: snapshot.cpu.usage, idle: false });
          setRadio(desiredModeKeyCycle ?? snapshot.modeKeyCycle);
        },
        unmount() {
          gpu.destroy();
          cpu.destroy();
        },
      };

      window.nitro.settings.get(MODE_INTRO_SEEN).then((seen) => {
        if (seen) return;
        window.nitro.settings.set(MODE_INTRO_SEEN, true);
        modeIntroDialog();
      }, () => {});
    },
    update(snapshot) {
      current?.update(snapshot);
    },
    unmount() {
      current?.unmount();
      current = null;
    },
  };

  // Keep the driver's mode-key setting in line with the user's choice (module parameters reset on boot).
  window.NitroModeKey = {
    enforce(snapshot) {
      if (desiredModeKeyCycle === undefined || snapshot.modeKeyCycle == null) return;
      if (snapshot.modeKeyCycle !== desiredModeKeyCycle) {
        window.nitro.controls.setModeKeyCycle(desiredModeKeyCycle).catch((error) => console.error(error));
      }
    },
  };

  window.NitroModeGauges = { clockGauge };
})();
