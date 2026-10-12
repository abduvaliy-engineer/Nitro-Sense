(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ACER = "../assets/acer";

  const MODES = {
    "low-power": { name: "Eco", model: "fighter_eco", clip: "EcoMode" },
    quiet: { name: "Quiet", model: "fighter_quiet", clip: "QuietMode" },
    balanced: { name: "Balanced", model: "fighter_default", clip: "DefaultMode" },
    "balanced-performance": { name: "Performance", model: "fighter_extreme", clip: "ExtremeMode" },
    performance: { name: "Turbo", model: "fighter_turbo", clip: "TurboMode" },
  };

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

  // ---------- usage history (NitroSense keeps a 720-sample FIFO, pre-filled with zeros) ----------

  const HISTORY_LENGTH = 720;
  const startTime = Date.now();
  const history = {
    gpu: Array.from({ length: HISTORY_LENGTH }, () => ({ value: 0, time: startTime })),
    cpu: Array.from({ length: HISTORY_LENGTH }, () => ({ value: 0, time: startTime })),
  };

  function record(snapshot) {
    const time = Date.now();
    history.gpu.push({ value: snapshot.gpu.active ? Math.ceil(snapshot.gpu.usage || 0) : 0, time });
    history.cpu.push({ value: Math.ceil(snapshot.cpu.usage || 0), time });
    history.gpu.shift();
    history.cpu.shift();
  }

  // ---------- mini usage chart (112×50, 1px per sample, newest on the right) ----------

  let chartId = 0;

  function miniChart(series) {
    const id = `mini-chart-${chartId++}`;
    const width = 112;
    const height = 50;
    const root = el("div", "mini-chart");
    const line = el("div", "mini-chart-line");
    const tip = el("div", "mini-chart-tip");
    const tipTime = el("p", "time");
    const tipValue = el("p", "value");
    const tipIdle = el("p", "idle", "Idle");
    tip.append(tipTime, tipValue, tipIdle);
    line.hidden = tip.hidden = true;

    const peakStop = svg("stop", { "stop-color": "#ff6624", "stop-opacity": "0.3" });
    const gradient = svg("linearGradient", { id: `${id}-grad`, gradientTransform: "rotate(90)" });
    gradient.append(
      svg("stop", { offset: "0%", "stop-color": "#ff6624", "stop-opacity": "0.3" }),
      peakStop,
      svg("stop", { offset: "100%", "stop-color": "#ff6624", "stop-opacity": "0" }),
    );
    const fillPath = svg("path", { fill: "white" });
    const mask = svg("mask", { id: `${id}-mask` });
    mask.append(fillPath);
    const defs = svg("defs");
    defs.append(gradient, mask);
    const area = svg("rect", { x: "0", y: "0", width, height, fill: `url(#${id}-grad)`, mask: `url(#${id}-mask)` });
    const stroke = svg("path", { fill: "transparent", stroke: "#ff6624" });
    const plot = svg("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    plot.append(defs, area, stroke);
    const plotBox = el("div", "mini-chart-plot");
    plotBox.append(plot);
    root.append(line, tip, plotBox);

    const y = (value) => height - 0.5 * value;

    function draw() {
      const samples = history[series].slice(-width);
      const offset = width - samples.length;
      const points = samples.map((s, i) => `${offset + i},${y(s.value)}`);
      stroke.setAttribute("d", `M${points.join("L")}`);
      fillPath.setAttribute("d", `M${points.join("L")}L${width},${height}L0,${height}Z`);
      const peak = Math.floor(Math.max(...samples.map((s) => s.value)));
      peakStop.setAttribute("offset", `${100 - peak}%`);
    }

    plotBox.addEventListener("mousemove", (event) => {
      const x = Math.round(event.offsetX);
      const sample = history[series][HISTORY_LENGTH - (width - x)];
      if (x <= 0 || !sample || sample.time === startTime) {
        line.hidden = tip.hidden = true;
        return;
      }
      line.hidden = tip.hidden = false;
      line.style.left = `${x}px`;
      tip.style.left = `${x <= 12 ? -29 : x - 41}px`;
      tipTime.textContent = new Date(sample.time).toTimeString().slice(0, 8);
      tipValue.textContent = `${sample.value}%`;
      tipValue.hidden = sample.value === 0;
      tipIdle.hidden = sample.value !== 0;
    });
    plotBox.addEventListener("mouseleave", () => { line.hidden = tip.hidden = true; });

    draw();
    return { root, draw };
  }

  // ---------- info card (stands in for Acer's Experience Zone carousel) ----------

  const CARD_ROTATE_MS = 8000;

  function chevron(direction) {
    const icon = svg("svg", { viewBox: "0 0 20 20", width: "20", height: "20" });
    icon.append(svg("path", { d: direction === "prev" ? "M11.5 6l-4 4 4 4" : "M8.5 6l4 4-4 4" }));
    return icon;
  }

  function infoCard() {
    const root = el("div", "home-card");
    const slides = ["device", "battery", "keyboard"].map((kind) => {
      const slide = el("div", `home-card-slide ${kind}`);
      const image = el("div", `home-card-image ${kind}`);
      const title = el("p", "home-card-title");
      const body = el("p", "home-card-body");
      const text = el("div", "home-card-text");
      text.append(title, body);
      slide.append(image, text);
      root.append(slide);
      return { slide, image, title, body };
    });

    const healthValue = el("span", "home-card-figure-value", "--");
    const meterFill = el("div", "home-card-meter-fill");
    const meter = el("div", "home-card-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", "Battery health");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.append(meterFill);
    const figure = el("div", "home-card-figure");
    figure.append(healthValue, el("span", "home-card-figure-caption", "Battery health"), meter);
    slides[1].image.append(figure);

    const prev = el("button", "home-card-arrow prev");
    const next = el("button", "home-card-arrow next");
    prev.setAttribute("aria-label", "Previous");
    next.setAttribute("aria-label", "Next");
    prev.append(chevron("prev"));
    next.append(chevron("next"));
    root.append(prev, next);

    let index = 0;
    let paused = false;
    const show = (i) => {
      index = (i + slides.length) % slides.length;
      slides.forEach((s, n) => s.slide.classList.toggle("active", n === index));
    };
    prev.addEventListener("click", () => show(index - 1));
    next.addEventListener("click", () => show(index + 1));
    root.addEventListener("mouseenter", () => { paused = true; });
    root.addEventListener("mouseleave", () => { paused = false; });
    const rotate = setInterval(() => !paused && show(index + 1), CARD_ROTATE_MS);

    async function refresh() {
      let info;
      try {
        info = await window.nitro.system.info();
      } catch (error) {
        console.error("system info failed", error);
        return;
      }
      const [device, battery, keyboard] = slides;

      device.title.textContent = "Device";
      device.body.textContent = [info.model || "Acer laptop", info.biosVersion && `BIOS ${info.biosVersion}`, info.biosDate]
        .filter(Boolean).join(" · ");

      const bat = info.battery;
      battery.title.textContent = "Battery";
      if (bat) {
        const parts = [
          bat.capacity != null && `${bat.capacity}% ${bat.status === "Charging" ? "charging" : "charged"}`,
          bat.cycles != null && `${bat.cycles} cycles`,
          info.chargeLimit != null && `Charge limit ${info.chargeLimit ? "on (80%)" : "off"}`,
        ];
        battery.body.textContent = parts.filter(Boolean).join(" · ");
        const health = bat.health ?? 0;
        healthValue.textContent = bat.health != null ? `${bat.health}%` : "--";
        meterFill.style.width = `${Math.min(health, 100)}%`;
        meterFill.dataset.level = health >= 80 ? "good" : health >= 60 ? "warning" : "critical";
        meter.setAttribute("aria-valuenow", String(health));
      } else {
        battery.body.textContent = "No battery detected";
      }

      keyboard.title.textContent = "Driver";
      const driver = !info.driver.loaded
        ? "linuwu-sense driver not loaded"
        : info.driver.writable ? "linuwu-sense driver ready" : "linuwu-sense driver needs permission (run install.sh)";
      const lighting = !info.keyboard.device
        ? "Keyboard lighting not found"
        : info.keyboard.writable ? "Keyboard lighting ready" : "Keyboard lighting needs permission";
      keyboard.body.textContent = `${driver} · ${lighting}`;
    }

    const refreshTimer = setInterval(refresh, 60000);
    show(0);
    refresh();

    return {
      root,
      destroy() {
        clearInterval(rotate);
        clearInterval(refreshTimer);
      },
    };
  }

  // ---------- left panel: GPU | CPU frequency ring ----------

  let showCpu = false;

  function frequencyPanel() {
    const root = el("div", "home-left home-left-frame");
    const top = el("div", "home-left-top");
    const box = el("div", "home-ring-box");
    const ring = el("div", "home-ring");

    const gpuButton = el("button", "", "GPU");
    const cpuButton = el("button", "", "CPU");
    const toggle = el("div", "home-switch");
    toggle.append(gpuButton, el("div", "home-switch-divider"), cpuButton);

    const value = el("p", "home-frequency-value", "--");
    const frequency = el("div", "home-frequency");
    frequency.append(value, el("p", "home-frequency-unit", "MHz"));

    const gpuChart = miniChart("gpu");
    const cpuChart = miniChart("cpu");
    const usageValue = el("span", "home-usage-value", "--%");
    const usage = el("div", "home-usage");
    usage.append(gpuChart.root, cpuChart.root, usageValue);
    const usageRow = el("div", "home-usage-row");
    usageRow.append(usage);

    const readout = el("div", "home-readout");
    readout.append(toggle, el("p", "home-frequency-label", "Frequency"), frequency, usageRow);

    const idleText = el("p", "", "Discrete GPU is idle");
    const idle = el("div", "home-gpu-idle");
    idle.append(idleText);

    box.append(ring, readout, idle);
    top.append(box);
    const card = infoCard();
    const cardWrap = el("div", "home-card-wrap");
    cardWrap.append(card.root);
    const cardArea = el("div", "home-card-area");
    cardArea.append(cardWrap);
    root.append(top, cardArea);
    // Artwork from the Microsoft Store build has NitroSense 5.0's taller frame (gauge and card share one
    // 368×600 frame); 5.0's layout is used then, so the card sits inside it.
    const frame = new Image();
    frame.onload = () => root.classList.toggle("legacy", frame.naturalHeight > 400);
    frame.src = `${ACER}/home/home_leftbg2.svg`;

    const animation = window.lottie?.loadAnimation({
      container: ring,
      renderer: "svg",
      loop: true,
      autoplay: true,
      path: `${ACER}/animation/homerotate-NS.json`,
      rendererSettings: { progressiveLoad: false, preserveAspectRatio: "xMinYMin slice" },
    });

    let last = null;

    function render() {
      gpuButton.classList.toggle("active", !showCpu);
      cpuButton.classList.toggle("active", showCpu);
      gpuChart.root.hidden = showCpu;
      cpuChart.root.hidden = !showCpu;
      if (!last) return;
      const gpuIdle = !last.gpu.active;
      idleText.hidden = !gpuIdle;
      if (showCpu) {
        value.textContent = last.cpu.frequency ? String(Math.ceil(last.cpu.frequency)) : "--";
        usageValue.textContent = last.cpu.usage ? `${Math.ceil(last.cpu.usage)}%` : "--%";
        cpuChart.draw();
      } else {
        value.textContent = gpuIdle || last.gpu.frequency == null ? "--" : String(Math.ceil(last.gpu.frequency));
        usageValue.textContent = gpuIdle || last.gpu.usage == null ? "--%" : `${Math.ceil(last.gpu.usage)}%`;
        gpuChart.draw();
      }
    }

    gpuButton.addEventListener("click", () => { showCpu = false; render(); });
    cpuButton.addEventListener("click", () => { showCpu = true; render(); });
    idleText.hidden = true;
    render();

    return {
      root,
      update(snapshot) { last = snapshot; render(); },
      destroy() {
        animation?.destroy();
        card.destroy();
      },
    };
  }

  // ---------- center: wordmark mode + 3D avatar (three.js r125, like NitroSense's A-Frame 1.2 scene) ----------

  const avatar = (() => {
    let renderer = null;
    let scene;
    let camera;
    let holder;
    let clock;
    let mixer = null;
    let animating = false;
    let rafId = 0;
    let lockUntil = 0;
    let lockTimer = 0;
    let lastPlayed = null;
    let mode = null;
    const cache = {};

    function init() {
      if (renderer || !window.THREE?.GLTFLoader) return Boolean(renderer);
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(400, 660);
      renderer.setClearColor(0x000000, 0);
      renderer.sortObjects = false;

      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xbbbbbb, 1));
      const sun = new THREE.DirectionalLight(0xffffff, 0.6);
      sun.position.set(-0.5, 1, 1);
      scene.add(sun);

      camera = new THREE.PerspectiveCamera(80, 400 / 660, 0.005, 10000);
      camera.position.set(0, 1.6, 0);
      holder = new THREE.Group();
      holder.position.set(0, 1.497, -0.185);
      scene.add(holder);
      clock = new THREE.Clock();
      return true;
    }

    function frame() {
      rafId = 0;
      mixer?.update(clock.getDelta());
      renderer.render(scene, camera);
      if (animating) rafId = requestAnimationFrame(frame);
    }

    function start() {
      clock.getDelta();
      if (!rafId) rafId = requestAnimationFrame(frame);
    }

    function load(spec) {
      if (cache[spec.model]) return cache[spec.model];
      cache[spec.model] = new Promise((resolve, reject) => {
        new THREE.GLTFLoader().load(`${ACER}/robot/${spec.model}.glb`, resolve, undefined, reject);
      });
      return cache[spec.model];
    }

    async function play(requested) {
      const now = performance.now();
      if (now < lockUntil) {
        // Same rule as NitroSense: replays are locked for 2 s; a different mode is applied afterwards.
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => requested !== lastPlayed && play(requested), lockUntil - now + 500);
        return;
      }
      lockUntil = now + 2000;
      lastPlayed = requested;
      const spec = MODES[requested] ?? MODES.balanced;
      let gltf;
      try {
        gltf = await load(spec);
      } catch (error) {
        console.error("avatar model failed to load", error);
        return;
      }
      if (holder.children[0] !== gltf.scene) {
        holder.clear();
        holder.add(gltf.scene);
      }
      mixer?.stopAllAction();
      mixer = new THREE.AnimationMixer(gltf.scene);
      const clip = THREE.AnimationClip.findByName(gltf.animations, spec.clip) ?? gltf.animations[0];
      if (clip) {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        mixer.addEventListener("finished", () => { animating = false; });
      }
      animating = Boolean(clip);
      start();
    }

    return {
      attach(host) {
        if (!init()) return;
        host.prepend(renderer.domElement);
        if (mode) play(mode);
        // A replay inside the 2-s lock is skipped: carry on with the animation the tab switch cut off,
        // or draw its final pose again, so the avatar never stays on an intro frame.
        if (animating) start();
        else if (holder.children.length) renderer.render(scene, camera);
      },
      detach() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        renderer?.domElement.remove();
      },
      setMode(next) {
        if (next === mode) return;
        mode = next;
        if (renderer?.domElement.isConnected) play(mode);
      },
      replay() {
        if (mode && renderer?.domElement.isConnected) play(mode);
      },
    };
  })();

  function centerColumn() {
    const root = el("div", "home-center");
    const labels = el("div", "home-center-labels");
    const modeName = el("div", "home-mode-name", "");
    labels.append(el("p", "home-mode-label", "System Mode"), modeName);

    const stage = el("div", "home-avatar");
    const hit = el("div", "home-avatar-hit");
    hit.setAttribute("aria-label", "Current System Mode");
    hit.addEventListener("click", () => avatar.replay());
    stage.append(hit);
    root.append(labels, stage);
    avatar.attach(stage);

    return {
      root,
      update(snapshot) {
        modeName.textContent = MODES[snapshot.profile]?.name ?? "";
        avatar.setMode(snapshot.profile);
      },
      destroy() { avatar.detach(); },
    };
  }

  // ---------- right panel: temperature gauges ----------

  const CIRCUMFERENCE = 440;
  const PX_PER_DEGREE = 3.3;

  // A 270° arc for 0-100 °C that starts at 6 o'clock (NitroSense's app-temperature-circular-bar).
  function temperatureGauge(id, label) {
    const root = el("div", "temp-gauge");
    root.setAttribute("role", "meter");
    root.setAttribute("aria-label", `${label} temperature`);
    root.setAttribute("aria-valuemin", "0");
    root.setAttribute("aria-valuemax", "100");

    const gradient = svg("linearGradient", { id: `${id}_circle` });
    for (const [offset, color] of [["0%", "#ff001e"], ["25%", "#ff001e"], ["100%", "#ffa000"]]) {
      gradient.append(svg("stop", { offset, "stop-color": color }));
    }
    const filter = svg("filter", { id: `${id}_filter` });
    filter.append(
      svg("feOffset", { in: "SourceGraphic", result: "offOut" }),
      svg("feGaussianBlur", { in: "offOut", stdDeviation: "5", result: "blurOut" }),
      svg("feBlend", { in: "SourceGraphic", in2: "blurOut", mode: "normal" }),
    );
    const defs = svg("defs");
    defs.append(gradient, filter);
    const arc = svg("circle", { cx: "90", cy: "90", r: "70", stroke: `url(#${id}_circle)`, filter: `url(#${id}_filter)` });
    const ring = svg("svg", { class: "temp-gauge-svg", width: "180", height: "180" });
    ring.append(defs, arc);

    const value = el("p", "temp-gauge-value", "--");
    const text = el("div", "temp-gauge-text");
    text.append(value, el("p", "temp-gauge-unit", "°C"));
    root.append(ring, text, el("p", "temp-gauge-label", label));

    function update(celsius) {
      const t = celsius || 0;
      const dash = PX_PER_DEGREE * t;
      arc.style.strokeDasharray = `${dash}px ${CIRCUMFERENCE - dash}px`;
      gradient.setAttribute("gradientTransform", `rotate(${0.9 * t - 45})`);
      value.textContent = t ? String(Math.round(t)) : "--";
      if (t) root.setAttribute("aria-valuenow", String(Math.round(t)));
      else root.removeAttribute("aria-valuenow");
    }

    update(0);
    return { root, update };
  }

  function temperaturePanel() {
    const root = el("div", "home-temperature");
    const gauges = {
      gpu: temperatureGauge("gpu", "GPU"),
      cpu: temperatureGauge("cpu", "CPU"),
      system: temperatureGauge("sys", "System"),
    };
    const bars = el("div", "temp-gauges");
    bars.append(gauges.gpu.root, gauges.cpu.root, gauges.system.root);
    const inner = el("div", "home-temperature-inner");
    inner.append(bars);
    root.append(inner);

    return {
      root,
      update(temps) {
        gauges.gpu.update(temps.gpu);
        gauges.cpu.update(temps.cpu);
        gauges.system.update(temps.system);
      },
    };
  }

  // ---------- page ----------

  let parts = null;

  window.NitroPages = window.NitroPages || {};
  window.NitroPages.Home = {
    mount(container) {
      const page = el("div", "home");

      const header = el("div", "home-header");
      const appname = el("img", "home-appname");
      appname.src = `${ACER}/home/home_appname.svg`;
      appname.alt = "NitroSense";
      const compactMode = el("div", "home-mode-compact");
      const compactName = el("div", "home-mode-name", "");
      compactMode.append(el("p", "home-mode-label", "System Mode"), compactName);
      header.append(appname, compactMode);

      const left = frequencyPanel();
      const center = centerColumn();
      const right = temperaturePanel();
      const leftCenter = el("div", "home-left-center");
      leftCenter.append(left.root, center.root);
      const row = el("div", "home-row");
      row.append(leftCenter, right.root);
      const rowWrap = el("div", "home-row-wrap");
      rowWrap.append(row);

      page.append(header, rowWrap);
      container.replaceChildren(page);
      parts = { left, center, right, compactName };
    },
    update(snapshot) {
      if (!parts) return;
      parts.left.update(snapshot);
      parts.center.update(snapshot);
      parts.right.update(snapshot.temps);
      parts.compactName.textContent = MODES[snapshot.profile]?.name ?? "";
    },
    collect(snapshot) {
      record(snapshot);
    },
    unmount() {
      parts?.left.destroy();
      parts?.center.destroy();
      parts = null;
    },
  };
})();
