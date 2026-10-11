// Widget panel items (NitroSense app-widget-list): Monitoring, Live Update, App Shortcut.
(() => {
  const ACER = "../assets/acer";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const dash = (value) => (value == null || value === 0 ? "--" : String(value));

  // ---------- Scenario Profile ----------

  function scenarioProfile(body) {
    const content = el("div", "wi-scenario");
    const trigger = el("button", "wi-dropdown");
    trigger.setAttribute("aria-haspopup", "listbox");
    const triggerText = el("span", "wi-dropdown-text", "");
    trigger.append(triggerText, el("div", "wi-dropdown-arrow"));

    const rows = el("div", "wi-scenario-rows");
    function row(icon, label, subTab) {
      const button = el("button", "wi-scenario-row");
      const left = el("section", "wi-scenario-cell");
      const image = el("img", "wi-scenario-icon");
      image.src = `${ACER}/widget/widget_scen_${icon}.svg`;
      image.alt = "";
      left.append(image, el("span", "wi-scenario-label", label));
      const value = el("span", "wi-scenario-value", "--");
      const chevron = el("img", "wi-scenario-chevron");
      chevron.src = `${ACER}/widget/widget_scen_arrow.svg`;
      chevron.alt = "";
      const right = el("section", "wi-scenario-cell");
      right.append(value, chevron);
      button.append(left, right);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.NitroScenarioNav?.open(subTab);
      });
      rows.append(button);
      return { value, button };
    }
    const modeValue = row("mode", "Mode", "Mode").value;
    const fanValue = row("fan", "Fan", "Fan_Control").value;
    const effectRow = row("effect", "Effect", "Pulsar_Lighting");
    // NitroSense hides the Effect row on laptops without supported lighting.
    effectRow.button.hidden = true;
    window.NitroLighting.load().then((info) => {
      effectRow.button.hidden = !info.supported;
      render();
    });
    content.append(trigger, rows);
    body.append(content);

    const scenario = window.NitroScenario;
    let state = null;
    let live = null;

    function render() {
      const profile = state?.profiles[state.active];
      if (!profile) return;
      triggerText.textContent = profile.name;
      modeValue.textContent = scenario.MODE_NAMES[live?.profile ?? profile.mode] ?? "--";
      fanValue.textContent = scenario.FAN_NAMES[profile.fan.mode] ?? "--";
      effectRow.value.textContent = window.NitroLighting.name(window.NitroLighting.current(profile.lighting)) ?? "--";
    }

    scenario.subscribe((next) => {
      state = next;
      render();
    });
    scenario.load();

    trigger.addEventListener("click", () => {
      if (window.NitroMenu.isOpen()) return window.NitroMenu.close();
      if (!state) return;
      trigger.classList.add("open");
      window.NitroMenu.open(trigger, state.profiles.map((profile, index) => ({
        label: profile.name,
        active: index === state.active,
        ariaLabel: `scenario profile ${profile.name}`,
        onSelect: () => index !== state.active && scenario.apply(index),
      })), { onClose: () => trigger.classList.remove("open") });
    });

    return {
      update(snapshot) {
        live = snapshot;
        scenario.sync(snapshot);
        render();
      },
    };
  }

  // ---------- Monitoring ----------

  // Index order is NitroSense's monitoringToolItemList; tiles always render in this order.
  const METRICS = [
    { group: "GPU", name: "Frequency", label: "GPU", unit: "MHz", value: (s) => dash(s.gpu.active ? s.gpu.frequency : 0) },
    { group: "GPU", name: "Usage", label: "GPU", unit: "%", value: (s) => (s.gpu.active ? String(Math.ceil(s.gpu.usage ?? 0)) : "--") },
    { group: "GPU", name: "Temperature", label: "GPU", unit: "°C", value: (s) => dash(s.temps.gpu) },
    { group: "GPU", name: "Fan speed", label: "GPU", unit: "RPM", value: (s) => String(s.fans.gpu ?? "--") },
    { group: "CPU", name: "Frequency", label: "CPU", unit: "MHz", value: (s) => dash(s.cpu.frequency) },
    { group: "CPU", name: "Usage", label: "CPU", unit: "%", value: (s) => dash(s.cpu.usage && Math.ceil(s.cpu.usage)) },
    { group: "CPU", name: "Temperature", label: "CPU", unit: "°C", value: (s) => dash(s.temps.cpu) },
    { group: "CPU", name: "Fan speed", label: "CPU", unit: "RPM", value: (s) => String(s.fans.cpu ?? "--") },
    { group: "Others", name: "System Temperature", label: "System", unit: "°C", value: (s) => dash(s.temps.system) },
    {
      group: "Others", name: "RAM Usage", label: "RAM", unit: "%",
      value: (s) => (s.ram.usage == null ? "--" : (Math.ceil(100 * s.ram.usage) / 100).toFixed(1)),
    },
  ];
  const DEFAULT_CHECKED = [false, true, true, false, false, true, true, false, true, true];
  const MAX_CHECKED = 6;
  const SETTINGS_KEY = "monitoringWidget";

  function monitoring(body) {
    const content = el("div", "wi-monitor");
    const grid = el("div", "wi-monitor-grid");
    content.append(grid);
    body.append(content);

    let checked = [...DEFAULT_CHECKED];
    let tiles = [];
    let last = null;

    function render() {
      tiles = [];
      grid.replaceChildren();
      METRICS.forEach((metric, index) => {
        if (!checked[index]) return;
        const value = el("span", "wi-tile-value", "--");
        const center = el("div", "wi-tile-center");
        center.append(value);
        const unit = el("div", "wi-tile-unit");
        unit.append(el("span", "", metric.unit));
        const label = el("div", "wi-tile-label");
        label.append(el("p", "", metric.label));
        const tile = el("div", "wi-tile");
        tile.append(label, center, unit);
        grid.append(tile);
        tiles.push({ metric, value });
      });
      if (last) update(last);
    }

    function update(snapshot) {
      last = snapshot;
      for (const tile of tiles) tile.value.textContent = tile.metric.value(snapshot);
    }

    window.nitro.settings.get(SETTINGS_KEY).then((stored) => {
      if (Array.isArray(stored) && stored.length === METRICS.length) checked = stored.map(Boolean);
      render();
    }, render);

    function setup() {
      const draft = [...checked];
      window.NitroDialog.open({
        size: "364x468",
        title: "Monitoring Widget",
        build(dialogBody, close) {
          const hint = el("div", "wi-setup-hint");
          hint.append(el("span", "", "Select up to 6 items to display on widget."));
          const groups = el("div", "wi-setup-groups");
          const rows = [];

          for (const group of ["GPU", "CPU", "Others"]) {
            const section = el("div", "wi-setup-group");
            const name = el("div", "wi-setup-group-name");
            name.append(el("span", "", group));
            const list = el("div", "wi-setup-group-rows");
            METRICS.forEach((metric, index) => {
              if (metric.group !== group) return;
              const box = el("button", "ns-checkbox");
              box.setAttribute("role", "checkbox");
              box.setAttribute("aria-label", `${group} ${metric.name}`);
              const tick = el("img");
              tick.src = `${ACER}/widget/checkbox_v.svg`;
              tick.alt = "";
              box.append(tick);
              const row = el("div", "wi-setup-row");
              row.append(box, el("span", "", metric.name));
              box.addEventListener("click", () => {
                const count = draft.filter(Boolean).length;
                if (draft[index] && count === 1) return;
                if (!draft[index] && count >= MAX_CHECKED) return;
                draft[index] = !draft[index];
                sync();
              });
              list.append(row);
              rows.push({ index, row, box, tick });
            });
            section.append(name, list);
            groups.append(section);
          }

          function sync() {
            const full = draft.filter(Boolean).length >= MAX_CHECKED;
            for (const { index, row, box, tick } of rows) {
              tick.hidden = !draft[index];
              box.setAttribute("aria-checked", String(draft[index]));
              const disabled = full && !draft[index];
              box.disabled = disabled;
              row.classList.toggle("disabled", disabled);
            }
          }

          const inner = el("div", "wi-setup");
          inner.append(hint, groups);
          const footer = el("div", "ns-dialog-footer");
          const done = el("button", "pill-btn w156", "Close");
          done.addEventListener("click", close);
          footer.append(done);
          dialogBody.append(inner, footer);
          sync();
        },
        onClose() {
          if (!draft.some(Boolean)) draft[1] = true;
          checked = draft;
          window.nitro.settings.set(SETTINGS_KEY, checked);
          render();
        },
      });
    }

    return { update, setup };
  }

  // ---------- Live Update (Linux: new releases of this app on GitHub) ----------

  const UPDATE_CACHE_KEY = "updates.lastCheck";
  const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
  const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
  let updateResult = null;
  let updatePromise = null;

  function checkForUpdates() {
    updatePromise ??= window.nitro.updates.check()
      .then((result) => {
        updateResult = result;
        window.nitro.settings.set(UPDATE_CACHE_KEY, { time: Date.now(), result });
      }, (error) => {
        console.error("update check failed", error);
        updateResult = { updates: [], failed: true };
        window.nitro.settings.set(UPDATE_CACHE_KEY, { time: Date.now(), result: updateResult });
      })
      .finally(() => { updatePromise = null; });
    return updatePromise;
  }

  // Automatic checks reuse a recent result; Check Now and refresh always ask GitHub.
  async function cachedUpdateResult() {
    const cached = await window.nitro.settings.get(UPDATE_CACHE_KEY).catch(() => null);
    const maxAge = cached?.result?.failed ? RETRY_AFTER_FAILURE_MS : AUTO_CHECK_MS;
    if (cached?.result && Date.now() - cached.time < maxAge) updateResult = cached.result;
    return updateResult;
  }

  function liveUpdate(body) {
    const content = el("div", "wi-update");
    body.append(content);
    let checking = false;

    function render() {
      content.replaceChildren();
      if (checking) {
        const box = el("div", "wi-update-loading");
        const spinner = el("div", "wi-update-spinner");
        box.append(spinner);
        content.append(box);
        window.lottie?.loadAnimation({
          container: spinner, renderer: "svg", loop: true, autoplay: true,
          path: `${ACER}/animation/loading72-NS.json`,
        });
        return;
      }

      const updates = updateResult?.updates ?? [];
      const block = el("div", "wi-update-block");
      if (updates.length) {
        const rows = el("div", "wi-update-rows");
        const row = el("div", "wi-update-row");
        const count = el("div", "wi-update-count");
        count.append(el("span", "", String(updates.length)));
        const label = el("div", "wi-update-label");
        label.append(el("span", "", "Regular Updates"));
        row.append(count, label);
        rows.append(row);
        const refresh = el("button", "wi-update-refresh custom-btn");
        refresh.setAttribute("aria-label", "refresh live update");
        const icon = el("img");
        icon.src = `${ACER}/widget/ic_refresh.svg`;
        icon.alt = "";
        refresh.append(icon);
        refresh.addEventListener("click", check);
        const line = el("div", "wi-update-line");
        line.append(rows, refresh);
        block.append(line);
      } else {
        const empty = el("div", "wi-update-empty");
        empty.append(el("span", "", updateResult?.failed ? "Unable to check for updates" : "No items to update"));
        block.append(empty);
      }

      const button = el("button", "pill-btn w260 wi-update-button", updates.length ? "Update All" : "Check Now");
      button.addEventListener("click", () => (updates.length ? window.nitro.updates.open(updates[0].url) : check()));
      content.append(block, button);
    }

    async function check() {
      checking = true;
      render();
      await checkForUpdates();
      checking = false;
      render();
    }

    if (updateResult) render();
    else cachedUpdateResult().then((cached) => (cached ? render() : check()));
    return {};
  }

  // ---------- App Shortcut ----------

  function appShortcut(body) {
    const content = el("div", "wi-apps");
    body.append(content);

    window.nitro.shortcuts.list().then((apps) => {
      if (!apps.length) {
        const empty = el("div", "wi-apps-empty");
        empty.append(el("span", "", "You have not pinned apps to the list"));
        content.replaceChildren(empty);
        return;
      }
      const grid = el("div", "wi-apps-grid");
      for (const app of apps) {
        const button = el("button", "wi-app");
        button.setAttribute("aria-label", app.name);
        button.title = app.name;
        if (app.icon) {
          const icon = el("img");
          icon.src = app.icon;
          icon.alt = "";
          button.append(icon);
        } else {
          button.append(el("span", "wi-app-fallback", app.name.slice(0, 1)));
        }
        button.addEventListener("click", () => window.nitro.shortcuts.launch(app.id).catch((e) => console.error(e)));
        grid.append(button);
      }
      content.replaceChildren(grid);
    }, (error) => console.error("shortcut list failed", error));
    return {};
  }

  window.NitroWidgets = Object.assign(window.NitroWidgets || {}, {
    Scenario_Profile: { mount: scenarioProfile },
    Monitoring: { mount: monitoring },
    Live_Update: { mount: liveUpdate },
    App_Shortcut: { mount: appShortcut },
  });
})();
