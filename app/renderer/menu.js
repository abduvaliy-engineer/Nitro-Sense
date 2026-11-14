// Material-style dropdown menu (NitroSense mat-menu look), rendered in a full-window layer.
(() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // CSS cubic-bezier(x1, y1, x2, y2) as a function of the time fraction.
  function bezier(x1, y1, x2, y2) {
    const at = (a, b, t) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
    return (x) => {
      let low = 0;
      let high = 1;
      for (let i = 0; i < 24; i++) {
        const t = (low + high) / 2;
        if (at(x1, x2, t) < x) low = t;
        else high = t;
      }
      return at(y1, y2, (low + high) / 2);
    };
  }

  // NitroSense's mat-menu timing: the panel opens in 120 ms, its items fade in over 400 ms after 100 ms, and it
  // closes by fading out over 100 ms after 25 ms.
  const OPEN_MS = 120;
  const ITEMS_DELAY_MS = 100;
  const ITEMS_MS = 400;
  const CLOSE_DELAY_MS = 25;
  const CLOSE_MS = 100;
  const openEase = bezier(0, 0, 0.2, 1);
  const itemsEase = bezier(0.55, 0, 0.55, 0.2);
  const part = (elapsed, delay, duration) => Math.min(1, Math.max(0, (elapsed - delay) / duration));

  // Runs draw(elapsed ms) once per frame until it returns false. Returns a function that stops it.
  function animate(draw) {
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      frame = draw(Math.max(0, now - start)) ? requestAnimationFrame(tick) : 0;
    });
    return () => cancelAnimationFrame(frame);
  }

  let current = null;

  function close() {
    if (!current) return;
    const { layer, menu, stop, onClose } = current;
    current = null;
    stop();
    const from = Number(menu.style.opacity) || 0;
    animate((elapsed) => {
      const done = part(elapsed, CLOSE_DELAY_MS, CLOSE_MS);
      menu.style.opacity = String(from * (1 - done));
      if (done < 1) return true;
      layer.remove();
      return false;
    });
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
    const stop = animate((elapsed) => {
      const opened = openEase(part(elapsed, 0, OPEN_MS));
      menu.style.opacity = String(opened);
      menu.style.transform = opened < 1 ? `scale(${0.8 + 0.2 * opened})` : "none";
      menu.style.setProperty("--ns-menu-items", String(itemsEase(part(elapsed, ITEMS_DELAY_MS, ITEMS_MS))));
      return elapsed < ITEMS_DELAY_MS + ITEMS_MS;
    });
    current = { layer, menu, stop, onClose };
  }

  addEventListener("resize", close);
  window.NitroMenu = { open, close, isOpen: () => Boolean(current) };
})();
