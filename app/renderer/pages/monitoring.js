// Monitoring tab (NitroSense app-monitor): GPU, CPU and System cards, each with a temperature (and usage) history
// chart like NitroSense's app-monitoring-line-chart, plus RAM and network rates.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ACER = "../assets/acer";
  const LINUX_LATER = "Not available on Linux yet";
  const GPU_NAME_KEY = "monitoring.gpuName";
  const RED = "#ff001e";
  const ORANGE = "#ffa000";

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

  // ---------- history: NitroSense's 720-sample FIFO per metric, pre-filled with zeros ----------

  const HISTORY_LENGTH = 720;
  const startTime = Date.now();
  const history = { time: new Array(HISTORY_LENGTH).fill(startTime) };
  for (const key of ["gpuTemp", "gpuUsage", "cpuTemp", "cpuUsage", "sysTemp"]) history[key] = new Array(HISTORY_LENGTH).fill(0);

  function push(list, value) {
    list.push(value);
    list.shift();
  }

  function record(snapshot) {
    push(history.time, Date.now());
    push(history.gpuTemp, snapshot.temps.gpu ?? 0);
    push(history.gpuUsage, snapshot.gpu.active ? snapshot.gpu.usage ?? 0 : 0);
    push(history.cpuTemp, snapshot.temps.cpu ?? 0);
    push(history.cpuUsage, snapshot.cpu.usage ?? 0);
    push(history.sysTemp, snapshot.temps.system ?? 0);
  }

  const clock = (time) => new Date(time).toTimeString().slice(0, 8);

  // ---------- line chart (100px tall, 1px per sample, newest on the right, range 0-100) ----------

  const CHART_HEIGHT = 100;
  let chartId = 0;

  function lineChart(label, temperature, usage) {
    const id = `mon-chart-${chartId++}`;
    const root = el("div", "mon-chart");
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", label);

    const line = el("div", "mon-chart-line");
    const tip = el("div", "mon-chart-tip");
    const tipTime = el("p", "time");
    const tipTemp = el("p", "temp");
    const tipUsage = el("p", "usage");
    const tipIdle = el("p", "idle", "Idle");
    tip.append(tipTime, tipTemp, tipUsage, tipIdle);
    line.append(tip);
    line.hidden = true;

    const plot = svg("svg", { width: "100%", height: CHART_HEIGHT, preserveAspectRatio: "none" });
    const defs = svg("defs");
    plot.append(defs);
    const layers = [[temperature, RED], [usage, ORANGE]].filter(([key]) => key).map(([key, color], n) => {
      const peak = svg("stop", { "stop-color": `${color}4d` });
      const gradient = svg("linearGradient", { id: `${id}-grad${n}`, gradientTransform: "rotate(90)" });
      gradient.append(svg("stop", { offset: "0%", "stop-color": `${color}4d` }), peak, svg("stop", { offset: "100%", "stop-color": `${color}00` }));
      const fill = svg("path", { fill: "white" });
      const mask = svg("mask", { id: `${id}-mask${n}` });
      mask.append(fill);
      defs.append(gradient, mask);
      const area = svg("rect", { x: 0, y: 0, height: CHART_HEIGHT, fill: `url(#${id}-grad${n})`, mask: `url(#${id}-mask${n})` });
      const stroke = svg("path", { fill: "transparent", stroke: color });
      plot.append(area, stroke);
      return { key, peak, fill, area, stroke };
    });
    const plotBox = el("div", "mon-chart-plot");
    plotBox.append(plot);
    root.append(line, plotBox);

    function draw() {
      const width = Math.floor(root.getBoundingClientRect().width);
      if (!width) return;
      plot.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
      for (const layer of layers) {
        const data = history[layer.key];
        const start = data.length - Math.min(data.length, width);
        const points = [];
        for (let i = start; i < data.length; i++) {
          const x = i === start ? 0 : width > HISTORY_LENGTH ? Math.floor(((i - start) * width) / data.length) : i - start;
          points.push(`${x},${CHART_HEIGHT - (CHART_HEIGHT / 100) * data[i]}`);
        }
        layer.stroke.setAttribute("d", `M${points.join("L")}`);
        layer.fill.setAttribute("d", `M0,${CHART_HEIGHT}L${points.join("L")}L${width},${CHART_HEIGHT}Z`);
        layer.area.setAttribute("width", width);
        layer.peak.setAttribute("offset", `${100 - Math.floor(Math.max(...data))}%`);
      }
    }

    // NitroSense reads the sample under the pointer and keeps the readout hidden over the pre-filled part.
    plotBox.addEventListener("mousemove", (event) => {
      const x = event.offsetX;
      const width = plotBox.offsetWidth;
      const index = (width > HISTORY_LENGTH ? Math.floor((HISTORY_LENGTH * x) / width) : HISTORY_LENGTH - (width - x)) - 1;
      const time = history.time[index];
      if (x <= 0 || time === undefined || clock(time) === clock(startTime)) {
        line.hidden = true;
        return;
      }
      const temp = history[temperature][index];
      const used = usage ? Math.ceil(history[usage][index]) : 0;
      tipTime.textContent = clock(time);
      tipTemp.textContent = `${temp}°C`;
      tipUsage.textContent = `${used}%`;
      tipTemp.hidden = temp === 0;
      tipUsage.hidden = used === 0;
      tipIdle.hidden = temp !== 0 || used !== 0;
      line.style.left = `${x - 1}px`;
      tip.style.setProperty("--pos-x", `${x <= 12 ? -29 - x : -41}px`);
      line.hidden = false;
    });
    plotBox.addEventListener("mouseleave", () => { line.hidden = true; });

    const resize = new ResizeObserver(() => draw());
    resize.observe(root);
    return { root, draw, destroy: () => resize.disconnect() };
  }

  // ---------- cards ----------

  // One label/value column (NitroSense's w-35 block): "Fan speed" over "1827 RPM".
  function stat(label, unit, valueClass = "mon-stat-value") {
    const root = el("div", "mon-stat");
    const value = el("span", "mon-value", "--");
    const unitText = el("span", "mon-stat-unit", unit);
    const line = el("p", valueClass);
    line.append(value, unitText);
    root.append(el("p", "mon-stat-label", label), line);
    return { root, line, value, unit: unitText };
  }

  function rangeLine(lastClass) {
    const min = el("span", "mon-range-min", "Min : --°");
    const max = el("span", lastClass, "Max : --°");
    const root = el("p", "mon-range");
    root.append(min, max);
    return { root, set: (low, high) => { min.textContent = `Min : ${low}°`; max.textContent = `Max : ${high}°`; } };
  }

  // GPU and CPU cards: name, "Temperature / Usage", chart and range on the left, big readouts on the right.
  function deviceCard(kind) {
    const gpu = kind === "GPU";
    const name = el("p", "mon-name", "--");
    const chart = lineChart(`${kind} temperature and usage history`, gpu ? "gpuTemp" : "cpuTemp", gpu ? "gpuUsage" : "cpuUsage");
    const chartBox = el("div", "mon-chart-box");
    chartBox.append(chart.root);
    const range = rangeLine(gpu ? "mon-range-max-edge" : "mon-range-max");
    const main = el("div", "mon-main");
    main.append(name, el("p", "mon-caption", "Temperature / Usage"), chartBox, range.root);

    const temp = el("p", "mon-big temp", "--");
    const usage = el("p", "mon-big usage", "--");
    const side = el("div", "mon-side");
    side.append(el("p", "mon-side-title", kind), temp, el("p", "mon-unit", "°C"), usage, el("p", "mon-unit", "%"));

    const row = el("div", "mon-row");
    row.append(main, side);

    const valueClass = gpu ? "mon-stat-value" : "mon-stat-value mt2";
    const fan = stat("Fan speed", "RPM", valueClass);
    const frequency = stat("Frequency", "MHz", valueClass);
    let details = null;
    if (!gpu) {
      // NitroSense's CPU Details button; it opens our own per-CPU monitor.
      details = el("button", "mon-info custom-btn");
      details.setAttribute("aria-label", "open cpu detail dialog");
      details.disabled = true;
      details.title = LINUX_LATER;
      const image = el("img");
      image.src = `${ACER}/scenario/ic_infomation.svg`;
      image.alt = "";
      details.append(image);
      details.addEventListener("click", openCoreDialog);
      frequency.line.append(details);
    }
    const stats = el("div", "mon-stats");
    stats.append(fan.root, frequency.root);

    const root = el("div", `ns-card mon-card mon-${kind.toLowerCase()}`);
    root.append(row, stats);
    let idle = null;
    if (gpu) {
      idle = el("p", "mon-idle", "Discrete GPU is idle");
      idle.hidden = true;
      root.append(idle);
    }
    return { root, chart, name, temp, usage, range, fan, frequency, idle, details };
  }

  function section(title, ...stats) {
    const row = el("div", "mon-stats tight");
    row.append(...stats.map((s) => s.root));
    const root = el("div", "mon-section");
    root.append(el("p", "mon-section-title", title), row);
    return root;
  }

  function systemCard() {
    const chart = lineChart("System temperature history", "sysTemp");
    const chartBox = el("div", "mon-chart-box");
    chartBox.append(chart.root);
    const range = rangeLine("mon-range-max");

    const fan = stat("Fan speed", "RPM");
    const ramFrequency = stat("Frequency", "MHz");
    const ramUsage = stat("Usage", "GB");
    const ramRatio = el("span", "mon-value", "(--%)");
    ramUsage.line.append(ramRatio);
    const net = {
      ethernet: { download: stat("Download", "Kbps"), upload: stat("Upload", "Kbps") },
      wifi: { download: stat("Download", "Kbps"), upload: stat("Upload", "Kbps") },
    };
    const fanSection = section("Fan", fan);
    fanSection.hidden = true;
    const sections = el("div", "mon-sections");
    sections.append(
      fanSection,
      section("RAM", ramFrequency, ramUsage),
      section("Ethernet", net.ethernet.download, net.ethernet.upload),
      section("Wi-Fi", net.wifi.download, net.wifi.upload),
    );
    const main = el("div", "mon-system-main");
    main.append(chartBox, range.root, sections);

    const temp = el("p", "mon-big temp", "--");
    const side = el("div", "mon-side");
    side.append(temp, el("p", "mon-unit", "°C"));
    const row = el("div", "mon-row");
    row.append(main, side);

    const root = el("div", "ns-card mon-system");
    root.append(el("p", "mon-system-title", "System"), el("p", "mon-caption", "Temperature"), row);
    return { root, chart, temp, range, fan, fanSection, ramFrequency, ramUsage, ramRatio, net };
  }

  // ---------- CPU Details dialog: our own per-CPU monitor (btop-style; NitroSense's only lists clocks) ----------

  // Two minutes of usage per logical CPU (one sample per poll), recorded on every poll so the graphs are full when
  // the dialog opens. Keyed by CPU number, so a CPU going offline doesn't shift the others' history.
  const CORE_SAMPLES = 60;
  const coreHistory = new Map();

  function recordCores(cores = []) {
    const seen = new Set();
    for (const { id, usage } of cores) {
      seen.add(id);
      if (!coreHistory.has(id)) coreHistory.set(id, new Array(CORE_SAMPLES).fill(null));
      push(coreHistory.get(id), usage);
    }
    for (const id of coreHistory.keys()) if (!seen.has(id)) coreHistory.delete(id);
  }

  // Small version of the Monitoring line chart, sized to its box: the samples (0-100, null = 0) span the width,
  // oldest on the left; one 1px line per series over its gradient fill, temperature first so usage draws on top.
  function miniChart(className, colors) {
    const id = `mon-chart-${chartId++}`;
    const root = el("div", className);
    const plot = svg("svg", { width: "100%", height: "100%", preserveAspectRatio: "none" });
    const defs = svg("defs");
    plot.append(defs);
    const layers = colors.map((color, n) => {
      const peak = svg("stop", { "stop-color": `${color}4d` });
      const gradient = svg("linearGradient", { id: `${id}-grad${n}`, gradientTransform: "rotate(90)" });
      gradient.append(svg("stop", { offset: "0%", "stop-color": `${color}4d` }), peak, svg("stop", { offset: "100%", "stop-color": `${color}00` }));
      const fill = svg("path", { fill: "white" });
      const mask = svg("mask", { id: `${id}-mask${n}` });
      mask.append(fill);
      defs.append(gradient, mask);
      const area = svg("rect", { x: 0, y: 0, fill: `url(#${id}-grad${n})`, mask: `url(#${id}-mask${n})` });
      const stroke = svg("path", { fill: "transparent", stroke: color });
      plot.append(area, stroke);
      return { peak, fill, area, stroke };
    });
    root.append(plot);

    function draw(...series) {
      const box = root.getBoundingClientRect();
      const width = Math.floor(box.width);
      const height = Math.floor(box.height);
      if (!width || !height) return;
      plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
      series.forEach((data, n) => {
        const layer = layers[n];
        const values = (data.length ? data : [0, 0]).map((v) => Math.min(100, Math.max(0, v ?? 0)));
        const last = Math.max(1, values.length - 1);
        // 100 % sits 1px below the top so the line stays visible.
        const points = values.map((v, i) => `${Math.round((i * width * 10) / last) / 10},${Math.round((height - ((height - 1) * v) / 100) * 10) / 10}`);
        layer.stroke.setAttribute("d", `M${points.join("L")}`);
        layer.fill.setAttribute("d", `M0,${height}L${points.join("L")}L${width},${height}Z`);
        layer.area.setAttribute("width", width);
        layer.area.setAttribute("height", height);
        layer.peak.setAttribute("offset", `${100 - Math.floor(Math.max(0, ...values))}%`);
      });
    }
    return { root, draw };
  }

  let lastSnapshot = null;
  let coreDialog = null;

  // One row per logical CPU: "CPU #n", its usage graph, usage and clock. Every other physical core is shaded, so
  // the two threads of a core read as a pair.
  function coreRow({ id, core }) {
    const row = el("div", core % 2 === 0 ? "mon-cd-row shade" : "mon-cd-row");
    const graph = miniChart("mon-cd-graph", [ORANGE]);
    const usage = el("span", "mon-cd-usage", "--");
    const clock = el("span", "mon-cd-clock", "--");
    row.append(el("span", "mon-cd-label", `CPU #${id + 1}`), graph.root, usage, clock);
    return { id, row, graph, usage, clock };
  }

  const percent = (value) => (value === null || value === undefined ? "--" : `${value}%`);

  function renderCores() {
    if (!coreDialog || !lastSnapshot) return;
    const d = coreDialog;
    const s = lastSnapshot;
    const cores = s.cpu.cores ?? [];
    // Rebuilt when CPUs go offline or come back (NitroSense's own dialog freezes instead).
    const layout = cores.map((c) => `${c.id}:${c.core}`).join(",");
    if (layout !== d.layout) {
      d.layout = layout;
      d.rows = cores.map(coreRow);
      d.list.replaceChildren(...d.rows.map((r) => r.row));
    }
    d.name.textContent = s.cpu.name ?? "--";
    d.total.draw(history.cpuTemp.slice(-CORE_SAMPLES), history.cpuUsage.slice(-CORE_SAMPLES));
    // Like the Monitoring cards: usage in amber, temperature in red, so these two also label the chart's lines.
    d.usage.textContent = percent(s.cpu.usage);
    d.clock.textContent = s.cpu.frequency ? `${s.cpu.frequency}MHz` : "--";
    d.temp.textContent = s.temps.cpu ? `${s.temps.cpu}°C` : "--";
    d.load.textContent = s.cpu.load?.every(Number.isFinite) ? s.cpu.load.map((v) => v.toFixed(2)).join(" ") : "--";
    cores.forEach((c, i) => {
      const r = d.rows[i];
      r.usage.textContent = percent(c.usage);
      r.usage.classList.toggle("hot", c.usage >= 90);
      r.clock.textContent = c.frequency === null ? "--" : `${c.frequency}MHz`;
      r.graph.draw(coreHistory.get(c.id) ?? []);
    });
  }

  function openCoreDialog() {
    if (coreDialog) return;
    // Laid out like a Monitoring card: device name, then "Temperature / Usage" over the chart.
    const name = el("p", "mon-name mon-cd-name", "--");
    const caption = el("div", "mon-cd-caption");
    caption.append(el("p", "mon-caption", "Temperature / Usage"), el("p", "mon-cd-span", "Last 2 min"));
    const head = el("div", "mon-cd-head");
    head.append(name, caption);
    const total = miniChart("mon-cd-total", [RED, ORANGE]);
    const stats = el("div", "mon-cd-stats");
    const stat = (label, valueClass = "") => {
      const value = el("span", `mon-cd-stat-value ${valueClass}`.trim(), "--");
      const item = el("span", "mon-cd-stat");
      item.append(el("span", "mon-cd-stat-label", label), value);
      stats.append(item);
      return value;
    };
    const usage = stat("Total", "usage");
    const clock = stat("Avg");
    const temp = stat("Temp", "temp");
    const load = stat("Load");
    const list = el("div", "mon-cores");
    coreDialog = { name, total, usage, clock, temp, load, list, layout: null, rows: [] };
    coreDialog.handle = window.NitroDialog.open({
      size: "468x560",
      title: "CPU Details",
      build(body, close) {
        const inner = el("div", "wi-setup");
        inner.append(head, total.root, stats, el("div", "mon-cd-rule"), list);
        const done = el("button", "pill-btn w156", "Close");
        done.setAttribute("aria-label", "close");
        done.addEventListener("click", close);
        const footer = el("div", "ns-dialog-footer");
        footer.append(done);
        body.append(inner, footer);
      },
      onClose() { coreDialog = null; },
    });
    renderCores();
  }

  // ---------- values (NitroSense's getGpuData / temperatureConvert / valueConvert / getCeil rules) ----------

  const dash = (value) => (value === null || value === undefined || value === 0 ? "--" : String(value));
  const ceilDash = (value) => (value ? String(Math.ceil(value)) : "--");

  // NitroSense calls the dGPU idle when frequency, usage and maximum clock all read 0; here, when it is suspended.
  const gpuIdle = (s) => s.gpu.active === false || (s.gpu.frequency === 0 && s.gpu.usage === 0 && !s.gpu.maxFrequency);
  const gpuValue = (value, idle) => (value === null || value === undefined || (value === 0 && idle) ? "--" : String(value));

  // Min and max over the history, ignoring the zeros of missing samples.
  function range(key) {
    const values = history[key].filter((v) => v > 0);
    return values.length ? [Math.min(...values), Math.max(...values)] : ["--", "--"];
  }

  // Kbps below 1000, then Mbps, one decimal.
  function rate(stat, kbps) {
    const value = kbps ?? 0;
    stat.value.textContent = value < 1000 ? value.toFixed(1) : (value / 1000).toFixed(1);
    stat.unit.textContent = value < 1000 ? "Kbps" : "Mbps";
  }

  let savedGpuName = null;
  window.nitro.settings.get(GPU_NAME_KEY).then((name) => {
    if (typeof name === "string" && !savedGpuName) savedGpuName = name;
  }, () => {});

  function rememberGpuName(name) {
    if (!name || name === savedGpuName) return;
    savedGpuName = name;
    window.nitro.settings.set(GPU_NAME_KEY, name);
  }

  function render(parts, s) {
    const { gpu, cpu, system } = parts;
    const idle = gpuIdle(s);
    const singleFan = s.fans.count === 1;

    gpu.name.textContent = s.gpu.name ?? savedGpuName ?? "--";
    gpu.temp.textContent = gpuValue(s.temps.gpu, idle);
    gpu.usage.textContent = gpuValue(s.gpu.active ? Math.ceil(s.gpu.usage ?? 0) : 0, idle);
    gpu.fan.value.textContent = gpuValue(s.fans.gpu, idle);
    gpu.frequency.value.textContent = gpuValue(s.gpu.active ? s.gpu.frequency : 0, idle);
    gpu.fan.root.hidden = singleFan;
    gpu.idle.hidden = !idle;
    gpu.range.set(...range("gpuTemp"));

    cpu.name.textContent = s.cpu.name ?? "--";
    cpu.temp.textContent = dash(s.temps.cpu);
    cpu.usage.textContent = ceilDash(s.cpu.usage);
    cpu.fan.value.textContent = dash(s.fans.cpu);
    cpu.frequency.value.textContent = dash(s.cpu.frequency);
    cpu.fan.root.hidden = singleFan;
    cpu.range.set(...range("cpuTemp"));
    // The CPU Details button works when the kernel reports anything per CPU.
    lastSnapshot = s;
    const hasCores = (s.cpu.cores ?? []).some((c) => c.frequency !== null || c.usage !== null);
    cpu.details.disabled = !hasCores;
    if (hasCores) cpu.details.removeAttribute("title");
    else cpu.details.title = LINUX_LATER;
    renderCores();

    system.temp.textContent = dash(s.temps.system);
    system.range.set(...range("sysTemp"));
    system.fanSection.hidden = !singleFan;
    system.fan.value.textContent = String(s.fans.cpu ?? "--");
    system.ramFrequency.value.textContent = dash(s.ram.frequency);
    const { usage, total } = s.ram;
    system.ramUsage.value.textContent = usage == null ? "--" : (Math.ceil((total / 1048576) * usage / 1024) / 100).toFixed(1);
    system.ramRatio.textContent = usage == null ? "(--%)" : `(${(Math.ceil(100 * usage) / 100).toFixed(1)}%)`;
    // NitroSense's service rounds the Wi-Fi rates up and leaves Ethernet's as they are.
    const net = s.network ?? {};
    rate(system.net.ethernet.download, net.ethernet?.download);
    rate(system.net.ethernet.upload, net.ethernet?.upload);
    rate(system.net.wifi.download, net.wifi && Math.ceil(net.wifi.download));
    rate(system.net.wifi.upload, net.wifi && Math.ceil(net.wifi.upload));

    for (const card of [gpu, cpu, system]) card.chart.draw();
  }

  // ---------- page ----------

  let parts = null;

  window.NitroPages = window.NitroPages || {};
  window.NitroPages.Monitoring = {
    mount(container) {
      const gpu = deviceCard("GPU");
      const cpu = deviceCard("CPU");
      const system = systemCard();

      const left = el("div", "mon-left");
      left.append(gpu.root, cpu.root);
      const right = el("div", "mon-right");
      right.append(system.root);
      const cards = el("div", "mon-cards");
      cards.append(left, right);

      const title = el("div", "mon-title-row");
      title.append(el("span", "mon-title", "Monitoring"));
      const inner = el("div", "mon-inner");
      inner.append(title, cards);
      const page = el("div", "mon-page");
      page.append(inner);
      container.replaceChildren(page);
      parts = { gpu, cpu, system };
      for (const card of [gpu, cpu, system]) card.chart.draw();
    },
    update(snapshot) {
      if (parts) render(parts, snapshot);
    },
    collect(snapshot) {
      record(snapshot);
      recordCores(snapshot.cpu.cores);
      rememberGpuName(snapshot.gpu.name);
    },
    unmount() {
      // Like NitroSense's dialogs, leaving the page closes it.
      coreDialog?.handle.close();
      for (const card of Object.values(parts ?? {})) card.chart.destroy();
      parts = null;
    },
  };
})();
