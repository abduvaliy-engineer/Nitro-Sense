// Scenario → Fan Control page (NitroSense app-fan-control): Auto / Max / Custom, per-fan custom speed.
(() => {
  const ACER = "../assets/acer";
  const scenario = window.NitroScenario;
  // linuwu-sense reads a 0 % fan value as "auto", so custom speeds start at 10 %.
  const MIN_CUSTOM = 10;

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

  // NitroSense: seconds per turn = max(1, 6 - 0.05 * round(rpm / 60)), clockwise, still at 0 RPM.
  // It re-times a CSS animation on every update (the blades jump); we integrate the angle instead.
  function spinner(image) {
    let angle = 0;
    let period = 0;
    let last = 0;
    let frame = 0;
    const step = (now) => {
      if (last) angle = (angle + (360 / period) * ((now - last) / 1000)) % 360;
      last = now;
      image.style.transform = `rotate(${angle}deg)`;
      frame = requestAnimationFrame(step);
    };
    return {
      setRpm(rpm) {
        if (!rpm) {
          cancelAnimationFrame(frame);
          frame = 0;
          last = 0;
          angle = 0;
          image.style.transform = "rotate(0deg)";
          return;
        }
        period = Math.max(1, 6 - 0.05 * Math.round(rpm / 60));
        if (!frame) frame = requestAnimationFrame(step);
      },
      stop: () => cancelAnimationFrame(frame),
    };
  }

  function activeProfile() {
    return scenario.state?.profiles[scenario.state.active] ?? null;
  }

  function applyFan(fan) {
    scenario.setFan(fan).catch((error) => console.error("fan change failed", error));
  }

  function fanBlock(title, key, onSpeed, onAuto) {
    const root = el("div", "fan-block");
    const art = el("div", "fan-art");
    const blades = icon(`${ACER}/fan/fan_large_nb.svg`, "fan-blades");
    art.append(blades);

    const rpm = el("p", "fan-rpm", "--");
    const text = el("div", "fan-text");
    text.append(el("p", "fan-title", title), rpm, el("p", "fan-unit", "RPM"));

    const custom = el("div", "fan-custom");
    const dim = el("div", "fan-custom-dim");
    const slider = window.NitroSlider.create({
      min: MIN_CUSTOM, max: 100, step: 10, value: 30,
      ariaLabel: `${key} fan custom fan speed`,
      onChange: onSpeed,
    });
    const tips = el("div", "fan-tips");
    tips.append(icon(`${ACER}/fan/ic_bartip_minus.svg`), icon(`${ACER}/fan/ic_bartip_plus.svg`));
    dim.append(slider.root, tips);
    const auto = el("button", "fan-auto", "Auto");
    auto.addEventListener("click", onAuto);
    custom.append(dim, auto);
    text.append(custom);
    root.append(art, text);

    return {
      root,
      rpm,
      spin: spinner(blades),
      render(speed, isAuto) {
        slider.setValue(Math.max(MIN_CUSTOM, speed));
        slider.setDisabled(isAuto);
        dim.classList.toggle("auto", isAuto);
        auto.classList.toggle("on", isAuto);
      },
    };
  }

  let current = null;

  window.NitroScenarioPages = window.NitroScenarioPages || {};
  window.NitroScenarioPages.Fan_Control = {
    mount(container) {
      const root = el("div", "fan-page");
      const card = el("div", "ns-card fan-card");
      const header = el("div", "mode-header");
      header.append(el("p", "mode-title", "Fan Control"));

      const cards = el("div", "mode-cards fan-modes");
      const modeButtons = {};
      for (const [mode, label] of [["auto", "Auto"], ["max", "Max"], ["custom", "Custom"]]) {
        const wrap = el("div", "mode-card-wrap");
        const button = el("button", "mode-card");
        const iconBox = el("div", "mode-card-icon fan-card-icon");
        iconBox.append(icon(`${ACER}/fan/ic_fan_${mode}.svg`));
        button.append(iconBox, el("p", "", label));
        button.addEventListener("click", () => update({ mode }));
        wrap.append(button);
        cards.append(wrap);
        modeButtons[mode] = button;
      }

      const message = el("div", "mode-message");
      const messageText = el("span", "");
      const messageBox = el("div", "mode-message-text");
      messageBox.append(messageText);
      message.append(messageBox);
      message.hidden = true;

      let fan = { mode: "auto", cpu: 30, gpu: 30, cpuAuto: true, gpuAuto: true, ...activeProfile()?.fan };

      function update(changes) {
        fan = { ...fan, ...changes };
        render();
        applyFan(fan);
      }

      const gpu = fanBlock("GPU", "gpu",
        (speed) => update({ gpu: speed, gpuAuto: false }),
        () => update({ gpuAuto: !fan.gpuAuto }));
      const cpu = fanBlock("CPU", "cpu",
        (speed) => update({ cpu: speed, cpuAuto: false }),
        () => update({ cpuAuto: !fan.cpuAuto }));

      const fans = el("div", "fan-blocks");
      fans.append(gpu.root, el("div", "fan-divider"), cpu.root);
      card.append(header, cards, message, fans);
      root.append(card);
      container.replaceChildren(root);

      function render() {
        for (const [mode, button] of Object.entries(modeButtons)) button.classList.toggle("selected", mode === fan.mode);
        card.classList.toggle("custom", fan.mode === "custom");
        gpu.render(fan.gpu, fan.gpuAuto);
        cpu.render(fan.cpu, fan.cpuAuto);
      }

      // The scenario store follows driver-side changes (Quiet/Eco forcing auto, other tools); mirror them.
      const unsubscribe = scenario.subscribe((state) => {
        const profileFan = state.profiles[state.active]?.fan;
        if (!profileFan || scenario.onBattery()) return;
        fan = { ...fan, ...profileFan };
        render();
      });

      render();

      current = {
        update(snapshot) {
          gpu.rpm.textContent = snapshot.fans?.gpu != null ? String(snapshot.fans.gpu) : "--";
          cpu.rpm.textContent = snapshot.fans?.cpu != null ? String(snapshot.fans.cpu) : "--";
          gpu.spin.setRpm(snapshot.fans?.gpu ?? 0);
          cpu.spin.setRpm(snapshot.fans?.cpu ?? 0);

          // NitroSense locks fan control in Quiet and Eco (linuwu-sense forces the fans to auto there too).
          const locked = snapshot.profile === "quiet" || snapshot.profile === "low-power";
          for (const button of Object.values(modeButtons)) button.disabled = locked;
          messageText.textContent = locked
            ? `Fan control has been disabled in ${snapshot.profile === "quiet" ? "Quiet" : "Eco"} mode.`
            : "";
          message.hidden = !locked;
        },
        unmount() {
          unsubscribe();
          gpu.spin.stop();
          cpu.spin.stop();
        },
      };
    },
    update(snapshot) {
      current?.update(snapshot);
    },
    unmount() {
      current?.unmount();
      current = null;
    },
  };
})();
