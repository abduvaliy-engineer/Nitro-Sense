// Material-style dropdown menu (NitroSense mat-menu look), rendered in a full-window layer.
(() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let current = null;

  function close() {
    if (!current) return;
    const { layer, onClose } = current;
    current = null;
    layer.querySelector(".ns-menu").classList.add("closing");
    setTimeout(() => layer.remove(), 125);
    onClose?.();
  }

  // items: [{ label, active, disabled, divider, ariaLabel, onSelect }]
  function open(anchor, items, { width, onClose } = {}) {
    close();
    const box = anchor.getBoundingClientRect();
    const layer = el("div", "ns-menu-layer");
    const menu = el("div", "ns-menu");
    menu.setAttribute("role", "menu");
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.width = `${width ?? box.width}px`;

    for (const item of items) {
      if (item.divider) {
        menu.append(el("div", "ns-menu-divider"));
        continue;
      }
      const row = el("div", "ns-menu-item");
      const button = el("button", item.active ? "active" : "");
      button.setAttribute("role", "menuitem");
      if (item.ariaLabel) button.setAttribute("aria-label", item.ariaLabel);
      if (item.disabled) {
        button.disabled = true;
        row.classList.add("disabled");
      }
      button.append(el("span", "", item.label));
      button.addEventListener("click", () => {
        close();
        item.onSelect?.();
      });
      row.append(button);
      menu.append(row);
    }

    layer.addEventListener("pointerdown", (event) => event.target === layer && close());
    layer.append(menu);
    document.body.append(layer);
    current = { layer, onClose };
  }

  addEventListener("resize", close);
  window.NitroMenu = { open, close, isOpen: () => Boolean(current) };
})();
