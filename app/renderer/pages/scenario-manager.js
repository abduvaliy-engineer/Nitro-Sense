// Scenario → Scenario Manager (NitroSense app-scenario-manager): the profile list, an editor for the
// selected profile and its App Sync apps. Selecting a card never applies it; edits are saved at once and
// reach the hardware only when the selected profile is the applied one.
(() => {
  const ACER = "../assets/acer";
  const scenario = window.NitroScenario;
  const lighting = window.NitroLighting;
  const TUTORIAL_KEY = "tutorial.scenarioManager";
  const AC_MODES = ["quiet", "balanced", "balanced-performance", "performance"];
  const BATTERY_MODES = ["balanced", "low-power"];
  const FAN_MODES = ["auto", "max", "custom"];
  const CARD_APPS = 8;

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

  function pill(label, ariaLabel, onClick) {
    const button = labelled("button", "pill-btn w156", ariaLabel, label);
    button.addEventListener("click", onClick);
    return button;
  }

  // ---------- tutorial (2 pages, shots 23–24) ----------

  function tutorial() {
    let page = 1;
    window.NitroDialog.open({
      size: "468x468",
      title: "The introduction of Scenario Manager",
      build(body, close) {
        const content = el("div", "scn-dialog-content sm-tutorial");
        const footer = el("div", "ns-dialog-footer");
        body.append(content, footer);
        const render = () => {
          const art = el("div", "scn-intro-art");
          if (page === 1) {
            art.append(icon(`${ACER}/dialog/dialog_tutorial_scenario_manager.svg`));
            const text = el("div", "sm-tutorial-text");
            text.append(
              el("p", "scn-dialog-text", "Scenario Manager allows you to manage your customized scenario profile settings."),
              el("p", "scn-dialog-text", "You can also set the App Sync function for each scenario."),
            );
            content.replaceChildren(art, text);
            footer.replaceChildren(pill("Next", "next", () => { page = 2; render(); }));
          } else {
            art.append(icon(`${ACER}/dialog/dialog_tutorial_scenario_appsync.svg`));
            const text = el("div", "sm-tutorial-steps");
            text.append(el("p", "scn-dialog-text", "How to use App Sync:"));
            for (const line of ["Turn on the App Sync function.",
              "Add a linked app. When you run this linked app, it will automatically switch the applied scenario profile."]) {
              const row = el("div", "sm-tutorial-step");
              row.append(icon(`${ACER}/dialog/dialog_item.svg`), el("span", "scn-dialog-text", line));
              text.append(row);
            }
            const note = el("div", "sm-tutorial-note");
            note.append(el("p", "", "*When you only have one scenario, you don't need to set up App Sync."));
            text.append(note);
            content.replaceChildren(art, text);
            footer.replaceChildren(pill("Previous", "previous", () => { page = 1; render(); }), pill("Close", "close", close));
          }
        };
        render();
      },
    });
  }

  // ---------- dropdowns ----------

  function dropdown(ariaLabel) {
    const trigger = el("button", "wi-dropdown sm-dropdown");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
    const text = el("span", "wi-dropdown-text");
    trigger.append(text, el("div", "wi-dropdown-arrow"));
    let options = [];
    trigger.addEventListener("click", () => {
      trigger.classList.add("open");
      window.NitroMenu.open(trigger, options, { onClose: () => trigger.classList.remove("open") });
    });
    return {
      root: trigger,
      // items: [{ value, label }]
      set(value, items, onPick) {
        text.textContent = items.find((item) => item.value === value)?.label ?? "";
        options = items.map((item) => ({
          label: item.label,
          active: item.value === value,
          ariaLabel: item.ariaLabel === undefined ? item.label : item.ariaLabel,
          onSelect: () => onPick(item.value),
        }));
      },
    };
  }

  function field(label, control) {
    const box = el("div", "sm-field");
    box.append(el("p", "sm-label", label), control);
    return box;
  }

  // ---------- page ----------

  let current = null;

  function mount(container) {
    const root = el("div", "sm-page");
    const inner = el("div", "sm-inner");
    const column = el("div", "sm-column");

    const warning = el("div", "sm-warning");
    const warningText = el("div", "sm-warning-text");
    warningText.append(el("span", "", "The currently executed Mode is locked due to power restrictions. Your edits in AC plugged in will be executed when the battery life is at least 40% capacity."));
    warning.append(warningText);
    warning.hidden = true;

    const card = el("div", "ns-card sm-card");

    const createRow = el("div", "sm-create-row");
    const create = labelled("button", "pill-btn w260", "create profile");
    create.append(el("span", "", "New Scenario Profile"));
    create.addEventListener("click", () => window.NitroScenarioDialogs.edit("create"));
    createRow.append(create);

    const listRow = el("div", "sm-list-row");
    const listLabel = el("div", "sm-list-label");
    listLabel.append(el("p", "", "Profile List"));
    const noteBox = el("div", "sm-note-box");
    const note = el("p", "sm-note", "*This scenario profile is applied currently");
    noteBox.append(note);
    listRow.append(listLabel, noteBox);

    const body = el("div", "sm-body");

    // below 785 px: own profile dropdown + ⋮
    const narrow = el("div", "sm-narrow");
    const narrowPick = dropdown("scenario profile menu");
    const narrowMore = labelled("button", "scn-btn scn-kebab sm-narrow-more", "scenario profile edit menu");
    narrowMore.append(icon(`${ACER}/scenario/system_scenario_more.svg`));
    narrowMore.addEventListener("click", () => editMenu(narrowMore, selected));
    narrow.append(narrowPick.root, narrowMore);

    const listColumn = el("div", "sm-list-column");
    const list = el("div", "sm-list");
    listColumn.append(list);

    const right = el("div", "sm-right");
    const narrowNote = el("div", "sm-narrow-note");
    narrowNote.append(el("p", "", "*This scenario profile is applied currently"));
    const panel = el("div", "sm-panel");

    // dropdown grid: AC | Battery, Fan | Lighting (no TrueHarmony on Linux)
    const grid = el("div", "sm-grid");
    const acMode = dropdown("mode menu");
    const batteryMode = dropdown("mode menu");
    const fanMode = dropdown("fan control menu");
    const effect = dropdown(null);
    const lightingBlock = el("div", "sm-field sm-lighting");
    lightingBlock.append(el("span", "sm-label", "Pulsar Lighting"));
    const radios = el("div", "sm-radios");
    const radioButtons = {};
    for (const [mode, label] of [["global", "Global"], ["area", "Area"]]) {
      const cell = el("div", "sm-radio-cell");
      const button = labelled("button", "sm-radio", `lighting ${mode === "global" ? "global" : "area"} effect`);
      const dot = el("div", "ns-radio");
      button.append(dot, el("span", "", label));
      button.addEventListener("click", () => edit((p) => { p.lighting.mode = mode; }));
      cell.append(button);
      radios.append(cell);
      radioButtons[mode] = dot;
    }
    const effectRow = el("div", "sm-effect-row");
    const effectBox = el("div", "sm-effect-box");
    effectBox.append(effect.root);
    effectRow.append(effectBox);
    lightingBlock.append(radios, effectRow);
    grid.append(
      field("Mode(AC Plugged In)", acMode.root),
      field("Mode(On Battery Power) ", batteryMode.root),
      field("Fan Control(AC Plugged In)", fanMode.root),
      lightingBlock,
    );

    // App Sync
    const sync = el("div", "sm-sync");
    const syncHead = el("div", "sm-sync-head");
    const info = labelled("button", "custom-btn sm-info", "more information");
    info.append(icon(`${ACER}/scenario/ic_infomation.svg`));
    info.addEventListener("click", tutorial);
    syncHead.append(el("span", "sm-label", "Enable App Sync"), info);
    const syncControls = el("div", "sm-sync-controls");
    const toggle = el("button", "sm-switch-button");
    const switchTrack = el("div", "sm-switch");
    switchTrack.append(el("span", "sm-switch-knob"));
    toggle.append(switchTrack);
    toggle.addEventListener("click", () => edit((p) => { p.appSync = !p.appSync; }));
    const disabledLine = el("div", "sm-sync-off");
    const disabledText = el("span", "", "App synchronization is disabled. You can still edit the list.");
    disabledLine.append(disabledText);
    syncControls.append(toggle, disabledLine);
    const tilesBox = el("div", "sm-tiles-box");
    const tiles = el("div", "sm-tiles");
    tilesBox.append(tiles);
    const missing = el("div", "sm-missing");
    sync.append(syncHead, syncControls, tilesBox, missing);

    panel.append(grid, sync);
    right.append(narrowNote, panel);
    body.append(narrow, listColumn, right);
    card.append(createRow, listRow, body);
    column.append(warning, card);
    inner.append(column);
    root.append(inner);
    container.replaceChildren(root);

    // ---------- state ----------

    let selected = scenario.state?.active ?? 0;
    let seenActive = scenario.state?.active;
    let seenCount = scenario.state?.profiles.length;
    let snapshot = null;
    // Linked apps' names, icons and whether they still exist (resolved in the main process).
    const known = new Map();
    const requested = new Set();
    const present = (apps) => apps.filter((app) => known.has(app.key) && !known.get(app.key).missing).map((app) => known.get(app.key));

    const profile = () => scenario.state?.profiles[selected];
    function edit(mutate) {
      scenario.update(selected, mutate).catch((error) => console.error("profile change failed", error));
    }

    function select(index) {
      selected = index;
      render();
      // NitroSense scrolls the card into view after 300 ms.
      setTimeout(() => list.children[index]?.scrollIntoView({ block: "nearest", inline: "nearest" }), 300);
    }

    function editMenu(anchor, index) {
      const state = scenario.state;
      const dialogs = window.NitroScenarioDialogs;
      window.NitroMenu.open(anchor, [
        { label: "Rename", onSelect: () => dialogs.edit("rename", index) },
        { label: "Duplicate", disabled: scenario.isFull(), onSelect: () => dialogs.edit("duplicate", index) },
        { divider: true },
        { label: "Restore", onSelect: () => dialogs.restore(index) },
        { label: "Remove", disabled: state.profiles.length <= 1, onSelect: () => dialogs.edit("remove", index) },
      ], { width: 160, onClose: () => anchor.closest(".sm-profile")?.classList.remove("menu-open") });
    }

    function profileCard(item, index, state) {
      const wrap = el("div", "sm-profile");
      const marker = icon(`${ACER}/scenario/scenario_applying.svg`, "sm-marker");
      marker.hidden = index !== state.active;
      const button = labelled("button", "sm-profile-btn", `select ${item.name} profile`);
      button.classList.toggle("selected", index === selected);
      button.addEventListener("click", () => select(index));
      const text = el("div", "sm-profile-text");
      text.append(el("p", "sm-profile-name", item.name));
      const apps = el("div", "sm-profile-apps");
      const linked = present(item.apps ?? []);
      if (!linked.length) {
        const none = el("div", "sm-profile-none");
        none.append(el("p", "", "None Apps Linked"));
        apps.append(none);
      } else {
        for (const app of linked.slice(0, CARD_APPS)) {
          const box = el("div", "sm-profile-app");
          box.append(window.NitroAppSync.appIcon(app, "sm-profile-app-icon"));
          apps.append(box);
        }
        if (linked.length > CARD_APPS) {
          const more = el("div", "sm-profile-more");
          more.append(el("span", "", `+${linked.length - CARD_APPS}`));
          apps.append(more);
        }
      }
      text.append(apps);
      const widget = el("div", "sm-profile-widget");
      const more = labelled("button", "sm-profile-menu", "more");
      more.append(icon(`${ACER}/scenario/system_scenario_more.svg`));
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        select(index);
        wrap.classList.add("menu-open");
        editMenu(more, index);
      });
      widget.append(more);
      button.append(text, widget);
      wrap.append(marker, button);
      return wrap;
    }

    function appTile(app) {
      const tile = el("div", "sm-tile");
      const remove = labelled("button", "custom-btn sm-tile-remove", `remove ${app.source ?? app.name} link`);
      remove.append(icon(`${ACER}/scenario/ic_delete.svg`));
      remove.addEventListener("click", () => edit((p) => { p.apps = p.apps.filter((a) => a.key !== app.key); }));
      const art = el("div", "sm-tile-art");
      const iconBox = el("div", "sm-tile-icon");
      iconBox.append(window.NitroAppSync.appIcon(app, "sm-tile-icon-img"));
      const nameBox = el("div", "sm-tile-name");
      nameBox.append(el("p", "", app.name));
      art.append(iconBox, nameBox);
      tile.append(remove, art);
      return tile;
    }

    function lookUp(state) {
      const unknown = state.profiles.flatMap((p) => p.apps).filter((app) => !known.has(app.key) && !requested.has(app.key));
      if (!unknown.length) return;
      unknown.forEach((app) => requested.add(app.key));
      window.NitroAppSync.resolve(unknown).then((list) => {
        list.forEach((app) => known.set(app.key, app));
        if (current) render();
      }).catch((error) => console.error("linked apps lookup failed", error));
    }

    // NitroSense lists linked apps that no longer exist; its × unlinks them all.
    function renderMissing(item) {
      const gone = item.apps.filter((app) => known.get(app.key)?.missing);
      missing.hidden = !gone.length;
      if (!gone.length) return missing.replaceChildren();
      const box = el("div", "sm-missing-box");
      const close = labelled("button", "custom-btn sm-missing-close", "close");
      close.append(icon(`${ACER}/scenario/ic_close.svg`));
      const keys = new Set(gone.map((app) => app.key));
      close.addEventListener("click", () => edit((p) => { p.apps = p.apps.filter((app) => !keys.has(app.key)); }));
      box.append(close, el("p", "", "File Path Missing"));
      for (const app of gone) {
        const row = el("div", "sm-missing-item");
        row.append(el("p", "", app.name), el("p", "", known.get(app.key).source ?? ""));
        box.append(row);
      }
      missing.replaceChildren(box);
    }

    function render() {
      const state = scenario.state;
      const item = profile();
      if (!state || !item) return;
      lookUp(state);
      const applied = selected === state.active;

      // list
      list.replaceChildren(...state.profiles.map((p, i) => profileCard(p, i, state)));
      note.hidden = !applied;
      narrowNote.hidden = !applied;
      create.disabled = scenario.isFull();
      narrowPick.set(selected, state.profiles.map((p, i) => ({ value: i, label: p.name })), select);

      // editor
      const names = scenario.MODE_NAMES;
      acMode.set(item.mode, AC_MODES.map((m) => ({ value: m, label: names[m] })), (m) => edit((p) => {
        if (m === "quiet" || p.mode === "quiet") p.fan.mode = "auto";
        p.mode = m;
      }));
      batteryMode.set(item.dcMode, BATTERY_MODES.map((m) => ({ value: m, label: names[m] })), (m) => edit((p) => { p.dcMode = m; }));
      fanMode.set(item.fan.mode, FAN_MODES.map((m) => ({ value: m, label: scenario.FAN_NAMES[m] })), (m) => edit((p) => { p.fan.mode = m; }));
      fanMode.root.disabled = item.mode === "quiet";
      lightingBlock.hidden = lighting.info?.supported === false;
      radioButtons.global.classList.toggle("on", item.lighting.mode !== "area");
      radioButtons.area.classList.toggle("on", item.lighting.mode === "area");
      effect.root.hidden = item.lighting.mode === "area";
      effect.set(item.lighting.global.effect, lighting.EFFECTS.map((e) => ({ value: e, label: lighting.name(e), ariaLabel: null })),
        (e) => edit((p) => { p.lighting.global.effect = e; }));

      // App Sync
      toggle.setAttribute("aria-label", `enable app sync toggle ${item.appSync}`);
      switchTrack.classList.toggle("on", item.appSync);
      disabledText.hidden = item.appSync;
      const add = el("div", "sm-tile sm-add");
      const addButton = labelled("button", "custom-btn sm-add-btn", "add linked app");
      addButton.append(icon(`${ACER}/scenario/scenario_addapp.svg`));
      addButton.disabled = item.apps.length >= scenario.APP_LIMIT;
      addButton.addEventListener("click", () => window.NitroAppSync.openAddDialog(selected));
      add.append(addButton, el("p", "sm-add-label", "Add Apps to Link"));
      tiles.replaceChildren(add, ...present(item.apps).map(appTile));
      renderMissing(item);

      // NitroSense's low-battery lock note (on AC below 40 %); the Mode Switch Key lock doesn't exist on Linux.
      const power = snapshot?.power;
      warning.hidden = !(power && power.ac !== false && power.battery != null && power.battery < 40);
    }

    // An apply from elsewhere (widget, App Sync, new/duplicate/remove) moves the selection to the applied
    // profile; plain edits keep it.
    const unsubscribe = scenario.subscribe((state) => {
      if (state.active !== seenActive || state.profiles.length !== seenCount) selected = state.active;
      seenActive = state.active;
      seenCount = state.profiles.length;
      selected = Math.min(selected, state.profiles.length - 1);
      render();
    });
    scenario.load();
    lighting.load().then(() => current && render());
    const closeMenus = () => window.NitroMenu.close();
    addEventListener("resize", closeMenus);

    current = {
      update(next) {
        const was = snapshot?.power;
        snapshot = next;
        if (was?.ac !== next.power?.ac || was?.battery !== next.power?.battery) render();
      },
      destroy() {
        unsubscribe();
        removeEventListener("resize", closeMenus);
        window.NitroMenu.close();
      },
    };
  }

  window.NitroScenarioPages = window.NitroScenarioPages || {};
  window.NitroScenarioPages.Scenario_Manager = {
    mount,
    update(snapshot) {
      current?.update(snapshot);
    },
    unmount() {
      current?.destroy();
      current = null;
    },
    // First time the frame's Scenario Manager button is used.
    async firstOpen() {
      if (await window.nitro.settings.get(TUTORIAL_KEY).catch(() => true)) return;
      window.nitro.settings.set(TUTORIAL_KEY, true);
      tutorial();
    },
  };
})();
