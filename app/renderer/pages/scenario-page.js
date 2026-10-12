// Scenario tab frame (NitroSense app-system-page): profile bar, ⋮ edit menu, sub-tabs, page container.
(() => {
  const ACER = "../assets/acer";
  const scenario = window.NitroScenario;

  // NitroSense hides Advanced Settings (TrueHarmony audio) on hardware without it; Linux has no backend for it.
  const SUB_TABS = [
    { id: "Mode", label: "Mode" },
    { id: "Fan_Control", label: "Fan Control" },
    { id: "Pulsar_Lighting", label: "Pulsar Lighting" },
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

  const lightingSupported = () => window.NitroLighting.info?.supported !== false;

  // ---------- dialogs ----------

  function footer(buttons) {
    const bar = el("div", "ns-dialog-footer");
    bar.append(...buttons);
    return bar;
  }

  function pill(label, onClick) {
    const button = el("button", "pill-btn w156", label);
    button.addEventListener("click", onClick);
    return button;
  }

  const EDIT = {
    create: { title: "New Scenario Profile", confirm: "Create", initial: () => "" },
    rename: { title: "Rename", confirm: "Save", initial: (index) => scenario.state.profiles[index].name },
    duplicate: { title: "Duplicate", confirm: "Create", initial: (index) => scenario.duplicateName(index) },
    remove: { title: "Remove Scenario Profile", confirm: "Remove" },
  };

  // index: the profile acted on (the applied one from the ⋮ menu; any card in the Scenario Manager).
  function editDialog(kind, index = scenario.state.active) {
    const spec = EDIT[kind];
    window.NitroDialog.open({
      size: "468x200",
      title: spec.title,
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        const confirm = pill(spec.confirm, () => {
          close();
          const name = input?.value.trim();
          if (kind === "create") scenario.add(name);
          else if (kind === "rename") scenario.rename(index, name);
          else if (kind === "duplicate") scenario.duplicate(index, name);
          else scenario.remove(index);
        });
        confirm.classList.add("ns-dialog-confirm");
        let input = null;
        if (kind === "remove") {
          content.append(el("p", "scn-dialog-text",
            "Are you sure to remove this scenario profile? The customized modification of this file will be lost after removal."));
        } else {
          content.append(el("p", "scn-dialog-text", "Scenario Profile Name"));
          const box = el("div", "ns-input");
          input = el("input");
          input.maxLength = 32;
          input.spellcheck = false;
          input.value = spec.initial(index);
          box.append(input);
          content.append(box);
          const validate = () => {
            const value = input.value.trim();
            confirm.disabled = !value || scenario.nameTaken(value);
          };
          input.addEventListener("input", validate);
          input.addEventListener("keydown", (event) => event.key === "Enter" && !confirm.disabled && confirm.click());
          validate();
          setTimeout(() => input.focus(), 0);
        }
        body.append(content, footer([pill("Cancel", close), confirm]));
      },
    });
  }

  function restoreDialog(index = scenario.state.active) {
    let choice = 0;
    window.NitroDialog.open({
      size: "468x468",
      title: "Restore Settings",
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        content.append(el("p", "scn-dialog-text scn-restore-text",
          "Reset all settings and clear “App Sync” settings of this Scenario to initial state. You can choose the initial settings after restoration."));

        const label = el("p", "scn-dialog-text scn-restore-label", "Restore Settings to");
        const trigger = el("button", "wi-dropdown scn-restore-dropdown");
        const triggerText = el("span", "wi-dropdown-text");
        trigger.append(triggerText, el("div", "wi-dropdown-arrow"));

        const rows = el("div", "scn-restore-rows");
        const preview = {};
        for (const [key, iconName] of [["mode", "mode"], ["fan", "fan"], ["effect", "effect"]]) {
          const row = el("div", "scn-restore-row");
          preview[key] = el("span", "");
          row.append(icon(`${ACER}/widget/widget_scen_${iconName}.svg`), preview[key]);
          row.hidden = key === "effect" && !lightingSupported();
          rows.append(row);
        }

        function render() {
          const preset = scenario.PRESETS[choice];
          triggerText.textContent = preset.name;
          preview.mode.textContent = scenario.MODE_NAMES[preset.mode];
          preview.fan.textContent = scenario.FAN_NAMES[preset.fan.mode];
          preview.effect.textContent = window.NitroLighting.name(window.NitroLighting.current(preset.lighting));
        }

        trigger.addEventListener("click", () => {
          trigger.classList.add("open");
          window.NitroMenu.open(trigger, scenario.PRESETS.map((preset, index) => ({
            label: preset.name,
            active: index === choice,
            onSelect: () => { choice = index; render(); },
          })), { onClose: () => trigger.classList.remove("open") });
        });

        content.append(label, trigger, rows);
        render();
        const restore = pill("Restore", () => { close(); scenario.restore(index, choice); });
        restore.classList.add("ns-dialog-confirm");
        body.append(content, footer([restore, pill("Cancel", close)]));
      },
    });
  }

  function introDialog() {
    window.NitroDialog.open({
      size: "468x468",
      title: "The introduction of Scenario",
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        const art = el("div", "scn-intro-art");
        art.append(icon(`${ACER}/dialog/dialog_tutorial_scenario2.svg`));
        content.append(
          art,
          el("p", "scn-intro-heading", "Scenario"),
          el("p", "scn-dialog-text scn-intro-lead", "We integrate important system settings into a Scenario. It includes:"),
          el("p", "scn-dialog-text", "- Mode"),
          el("p", "scn-dialog-text", "- Fan Control"),
          ...(lightingSupported() ? [el("p", "scn-dialog-text", "- Pulsar Lighting")] : []),
          el("p", "scn-dialog-text scn-intro-tail", "You can create and apply scenarios for different needs."),
        );
        body.append(content, footer([pill("Close", close)]));
      },
    });
  }

  // ---------- frame ----------

  let activeSub = "Mode";
  let previousSub = "Mode";
  let pendingSub = null;
  let parts = null;
  let lastSnapshot = null;

  function placeholder(name) {
    return {
      mount(container) {
        const box = el("div", "placeholder", name);
        container.replaceChildren(box);
      },
    };
  }

  function topBar() {
    const bar = el("div", "scn-topbar");
    const row = el("div", "scn-topbar-row");

    const label = el("div", "scn-label");
    label.append(el("span", "", "Scenario Profile"));

    const trigger = el("button", "wi-dropdown scn-dropdown");
    const triggerText = el("span", "wi-dropdown-text");
    trigger.append(triggerText, el("div", "wi-dropdown-arrow"));
    trigger.addEventListener("click", () => {
      const state = scenario.state;
      if (!state) return;
      trigger.classList.add("open");
      window.NitroMenu.open(trigger, state.profiles.map((profile, index) => ({
        label: profile.name,
        active: index === state.active,
        ariaLabel: `scenario profile ${profile.name}`,
        onSelect: () => index !== state.active && scenario.apply(index),
      })), { onClose: () => trigger.classList.remove("open") });
    });

    const kebab = el("button", "scn-btn scn-kebab");
    kebab.setAttribute("aria-label", "scenario profile edit menu");
    kebab.append(icon(`${ACER}/scenario/system_scenario_more.svg`));
    kebab.addEventListener("click", () => {
      const state = scenario.state;
      if (!state) return;
      window.NitroMenu.open(kebab, [
        { label: "Add New", disabled: scenario.isFull(), onSelect: () => editDialog("create") },
        { label: "Rename", onSelect: () => editDialog("rename") },
        { label: "Duplicate", disabled: scenario.isFull(), onSelect: () => editDialog("duplicate") },
        { divider: true },
        { label: "Restore", onSelect: () => restoreDialog() },
        { label: "Remove", disabled: state.profiles.length <= 1, onSelect: () => editDialog("remove") },
      ], { width: 160 });
    });

    const manager = el("button", "scn-btn scn-manager");
    manager.setAttribute("aria-label", "open scenario manager");
    manager.append(icon(`${ACER}/scenario/system_scenario_manager.svg`), el("span", "", "Scenario Manager"));
    manager.addEventListener("click", () => {
      selectSub("Scenario_Manager");
      window.NitroScenarioPages.Scenario_Manager?.firstOpen?.();
    });

    const info = el("button", "scn-info custom-btn");
    info.setAttribute("aria-label", "open scenario manager introduction");
    info.append(icon(`${ACER}/scenario/ic_infomation.svg`));
    info.addEventListener("click", introDialog);

    row.append(label, trigger, kebab, manager, info);
    bar.append(row);

    const unsubscribe = scenario.subscribe((state) => {
      triggerText.textContent = state.profiles[state.active]?.name ?? "";
    });
    scenario.load();
    return { root: bar, destroy: unsubscribe };
  }

  function subTabBar() {
    const bar = el("div", "scn-subtabs");
    const left = el("div", "scn-arrow-slot");
    const right = el("div", "scn-arrow-slot");
    const menu = el("div", "scn-menu");
    const list = el("div", "scn-menu-list");
    menu.append(list);
    bar.append(left, menu, right);

    const tabRow = el("div", "scn-menu-tabs");
    const buttons = SUB_TABS.map((tab) => {
      const button = el("button", "scn-subtab", tab.label);
      button.setAttribute("aria-label", tab.id);
      button.addEventListener("click", () => selectSub(tab.id));
      tabRow.append(button);
      return { tab, button };
    });

    // Area Lighting Control replaces the sub-tabs with a back arrow and its title.
    const backRow = el("div", "scn-back-row");
    const back = el("button", "scn-back custom-btn");
    back.append(icon(`${ACER}/scenario/ic_back.svg`));
    const backTitle = el("span", "scn-back-title");
    backRow.append(back, backTitle);
    backRow.hidden = true;
    list.append(tabRow, backRow);

    return {
      root: bar,
      render() {
        for (const { tab, button } of buttons) {
          button.classList.toggle("selected", tab.id === activeSub);
          button.hidden = tab.id === "Pulsar_Lighting" && !lightingSupported();
        }
      },
      // manager: the taller Scenario Manager header instead of the Area Lighting one.
      showBack(title, ariaLabel, onBack, { manager = false } = {}) {
        backRow.classList.toggle("manager", manager);
        backTitle.textContent = title;
        back.setAttribute("aria-label", ariaLabel);
        back.onclick = onBack;
        backRow.hidden = false;
        tabRow.hidden = true;
        left.hidden = true;
        right.hidden = true;
      },
      showTabs() {
        backRow.hidden = true;
        tabRow.hidden = false;
        left.hidden = false;
        right.hidden = false;
      },
    };
  }

  function selectSub(id) {
    if (!parts) return;
    parts.page?.unmount?.();
    parts.tabs.showTabs();
    // The Scenario Manager hides the profile bar and puts a back arrow where the sub-tabs were.
    const manager = id === "Scenario_Manager";
    if (manager && activeSub !== id) previousSub = activeSub;
    parts.top.root.hidden = manager;
    if (manager) parts.tabs.showBack("Scenario Manager", "back to previous page", () => selectSub(previousSub), { manager: true });
    activeSub = id;
    parts.tabs.render();
    const page = window.NitroScenarioPages?.[id] ?? placeholder(id === "Scenario_Manager" ? "Scenario Manager" : id.replace("_", " "));
    parts.page = page;
    page.mount(parts.container);
    if (lastSnapshot) page.update?.(lastSnapshot);
  }

  window.NitroPages = window.NitroPages || {};
  window.NitroPages.Scenario = {
    mount(container) {
      const root = el("div", "scn");
      const bars = el("div", "scn-bars");
      const top = topBar();
      const tabs = subTabBar();
      bars.append(top.root, tabs.root);
      const pageContainer = el("div", "scn-page");
      root.append(bars, pageContainer);
      container.replaceChildren(root);
      parts = { top, tabs, container: pageContainer, page: null };
      window.NitroLighting.load().then(() => parts?.tabs.render());
      // NitroSense always lands on Mode when the Scenario tab is opened from the header.
      activeSub = "Mode";
      previousSub = "Mode";
      selectSub(pendingSub ?? "Mode");
      pendingSub = null;
    },
    update(snapshot) {
      lastSnapshot = snapshot;
      parts?.page?.update?.(snapshot);
    },
    unmount() {
      parts?.page?.unmount?.();
      parts?.top.destroy();
      parts = null;
    },
  };

  // Sub-pages that take over the sub-tab bar (Area Lighting Control).
  window.NitroScenarioFrame = {
    showBack: (title, ariaLabel, onBack) => parts?.tabs.showBack(title, ariaLabel, onBack),
    showTabs: () => parts?.tabs.showTabs(),
  };

  // Widget rows and Details open a specific sub-tab (staying in the open Scenario tab when possible).
  window.NitroScenarioNav = {
    open(id) {
      if (parts) return selectSub(id);
      pendingSub = id;
      window.NitroApp?.selectTab("Scenario");
    },
  };

  window.NitroScenarioDialogs = { edit: editDialog, restore: restoreDialog };
})();
