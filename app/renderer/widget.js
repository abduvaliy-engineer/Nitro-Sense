// Right-hand widget panel (NitroSense's app-main #widget): toggle tab, gradient column, reorderable items.
(() => {
  const ACER = "../assets/acer/widget";
  // NitroSense puts the panel beside the page from 1528px; the Home row (1136px) still fits next to it
  // down to 1488px, which covers maximized windows that lose a few pixels to tiling-WM gaps.
  const WIDE = matchMedia("(min-width: 1488px)");
  const ORDER_KEY = "widget.order";

  const ITEMS = [
    { id: "Scenario_Profile", title: "Scenario Profile", details: "Scenario" },
    { id: "Monitoring", title: "Monitoring", details: "Monitoring", setup: true },
    { id: "Live_Update", title: "Live Update", details: "Live Update" },
    { id: "App_Shortcut", title: "App Shortcut", details: "App Center" },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toggleButton() {
    const button = el("button", "widget-toggle");
    const icon = el("img");
    icon.src = `${ACER}/widget_closeopen.svg`;
    icon.alt = "";
    button.append(icon);
    button.addEventListener("click", () => setOpen(!open));
    return button;
  }

  const row = document.getElementById("main-row");
  const column = document.getElementById("column");
  const panel = el("aside", "widget");
  const slot = el("div", "widget-toggle-slot");
  const panelToggle = toggleButton();
  slot.append(panelToggle);
  const columnToggle = toggleButton();
  columnToggle.classList.add("in-column");
  column.append(columnToggle);

  const background = el("div", "widget-bg");
  const list = el("div", "widget-list");
  background.append(list);
  panel.append(slot, background);
  row.append(panel);

  const mounted = {};
  let open = false;

  function setOpen(value) {
    open = value;
    panel.classList.toggle("open", open);
    row.classList.toggle("widget-open", open);
    background.inert = !open;
    for (const button of [panelToggle, columnToggle]) {
      button.setAttribute("aria-label", open ? "close widget" : "open widget");
      button.classList.toggle("closed", !open);
    }
  }

  function buildItem(item) {
    const root = el("div", "widget-item");
    root.dataset.id = item.id;

    const header = el("div", "widget-item-header");
    const headerRow = el("div", "widget-item-header-row");
    headerRow.append(el("span", "widget-item-title", item.title));
    if (item.setup) {
      const setup = el("button", "widget-item-setup custom-btn");
      setup.setAttribute("aria-label", "Monitoring settings");
      const icon = el("img");
      icon.src = `${ACER}/widget_setup.svg`;
      icon.alt = "";
      setup.append(icon);
      setup.addEventListener("click", () => mounted[item.id]?.setup?.());
      headerRow.append(setup);
    }
    const deco = el("img", "widget-item-decoline");
    deco.src = `${ACER}/widget_decoline.svg`;
    deco.alt = "";
    header.append(headerRow, deco);

    const body = el("div", "widget-item-body");

    const footer = el("div", "widget-item-footer");
    const details = el("button", "widget-details");
    const arrow = el("img");
    arrow.src = `${ACER}/widget_bottom_arrow.svg`;
    arrow.alt = "";
    details.append(el("span", "", "Details"), arrow);
    // Details of a page that isn't built yet (App Center, Acer's driver updates behind Live Update) is greyed out.
    if (item.id === "Scenario_Profile") details.addEventListener("click", () => window.NitroScenarioNav?.open("Scenario_Manager"));
    else if (window.NitroApp?.hasPage(item.details)) details.addEventListener("click", () => window.NitroApp.selectTab(item.details));
    else window.NitroApp?.unavailable(details);
    footer.append(details);

    root.append(header, body, footer);
    header.addEventListener("pointerdown", (event) => startDrag(event, header, root));
    const widget = window.NitroWidgets?.[item.id];
    mounted[item.id] = widget?.mount?.(body) ?? null;
    return root;
  }

  // Drag an item by its header to reorder (vertical only, like cdkDrag lockAxis y); the order is saved.
  function startDrag(event, handle, item) {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // synthetic events have no capturable pointer; the drag still works while the pointer stays on the handle
    }
    item.classList.add("dragging");
    const move = (e) => {
      const target = [...list.children]
        .filter((node) => node !== item)
        .find((node) => {
          const box = node.getBoundingClientRect();
          return e.clientY < box.top + box.height / 2;
        });
      if (target !== item.nextElementSibling) list.insertBefore(item, target ?? null);
    };
    const end = () => {
      item.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      window.nitro.settings.set(ORDER_KEY, [...list.children].map((node) => node.dataset.id));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async function build() {
    let order = null;
    try {
      order = await window.nitro.settings.get(ORDER_KEY);
    } catch {
      order = null;
    }
    const items = Array.isArray(order)
      ? [...ITEMS].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99))
      : ITEMS;
    list.replaceChildren(...items.map(buildItem));
  }

  // NitroSense opens the panel when it starts maximized; a wide window is our equivalent.
  setOpen(WIDE.matches);
  addEventListener("resize", () => {
    if (open && innerWidth < 784) setOpen(false);
  });
  build();

  window.NitroWidgetPanel = {
    update(snapshot) {
      for (const item of Object.values(mounted)) item?.update?.(snapshot);
    },
    rebuild: build,
  };
})();
