// NitroSense "predator-slider" (Angular Material slider look): hexagon thumb, orange fill, snaps to steps.
// Emits onChange only when a drag ends, on a track click or on a key press, like mat-slider's (change).
(() => {
  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // scale: the values at the track ends. NitroSense's fan sliders keep 0-100 although they start at 10.
  function create({ min = 0, max = 100, step = 10, value = min, scale = [0, 100], ariaLabel = "", onChange } = {}) {
    const root = el("div", "ns-slider");
    root.tabIndex = 0;
    root.setAttribute("role", "slider");
    root.setAttribute("aria-label", ariaLabel);
    root.setAttribute("aria-valuemin", String(min));
    root.setAttribute("aria-valuemax", String(max));
    const track = el("div", "ns-slider-track");
    const fill = el("div", "ns-slider-fill");
    const thumbBox = el("div", "ns-slider-thumb-box");
    thumbBox.append(el("div", "ns-slider-thumb"));
    track.append(el("div", "ns-slider-bg"), fill, thumbBox);
    root.append(track);

    let current = value;
    let disabled = false;

    const [low, high] = scale;

    function render() {
      const fraction = (current - low) / (high - low);
      fill.style.transform = `scaleX(${fraction})`;
      thumbBox.style.transform = `translateX(${fraction * 100 - 100}%)`;
      root.setAttribute("aria-valuenow", String(current));
    }

    function valueAt(clientX) {
      const box = track.getBoundingClientRect();
      const raw = low + ((clientX - box.left) / box.width) * (high - low);
      return Math.min(max, Math.max(min, Math.round((raw - low) / step) * step + low));
    }

    function commit(next) {
      const changed = next !== current;
      current = next;
      render();
      if (changed) onChange?.(current);
    }

    root.addEventListener("pointerdown", (event) => {
      if (disabled || event.button !== 0) return;
      root.setPointerCapture?.(event.pointerId);
      root.classList.add("sliding");
      const startValue = current;
      current = valueAt(event.clientX);
      render();
      const move = (e) => {
        current = valueAt(e.clientX);
        render();
      };
      const end = () => {
        root.classList.remove("sliding");
        root.removeEventListener("pointermove", move);
        root.removeEventListener("pointerup", end);
        root.removeEventListener("pointercancel", end);
        if (current !== startValue) onChange?.(current);
      };
      root.addEventListener("pointermove", move);
      root.addEventListener("pointerup", end);
      root.addEventListener("pointercancel", end);
    });

    root.addEventListener("keydown", (event) => {
      if (disabled) return;
      const keys = {
        ArrowLeft: -step, ArrowDown: -step, PageDown: -step,
        ArrowRight: step, ArrowUp: step, PageUp: step,
      };
      let next = null;
      if (event.key in keys) next = Math.min(max, Math.max(min, current + keys[event.key]));
      else if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      if (next === null) return;
      event.preventDefault();
      commit(next);
    });

    render();
    return {
      root,
      setValue(next) {
        if (root.classList.contains("sliding")) return;
        current = Math.min(max, Math.max(min, next));
        render();
      },
      setDisabled(value) {
        disabled = value;
        root.classList.toggle("disabled", value);
        root.setAttribute("aria-disabled", String(value));
        root.tabIndex = value ? -1 : 0;
      },
    };
  }

  window.NitroSlider = { create };
})();
