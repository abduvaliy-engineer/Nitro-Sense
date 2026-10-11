// Minimal MatDialog equivalent: dark backdrop, framed box, closes only through its own buttons.
(() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  window.NitroDialog = {
    // build(body, close) fills the dialog body; onClose runs once when the dialog closes.
    open({ size, title, build, onClose }) {
      const backdrop = el("div", "ns-backdrop");
      const dialog = el("div", `ns-dialog size-${size}`);
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", title);

      const closeRow = el("div", "ns-dialog-close-row");
      const closeButton = el("button", "ns-dialog-close");
      closeButton.setAttribute("aria-label", "close");
      closeRow.append(closeButton);
      const header = el("div", "ns-dialog-header");
      header.append(closeRow, el("p", "ns-dialog-title", title));
      const body = el("div", "ns-dialog-body");
      dialog.append(header, body);
      backdrop.append(dialog);

      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        backdrop.remove();
        onClose?.();
      }

      closeButton.addEventListener("click", close);
      build(body, close);
      document.body.append(backdrop);
      return { close };
    },
  };
})();
