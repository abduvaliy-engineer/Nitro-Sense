const TABS = ["Home", "Scenario", "Personal Settings", "Checkup", "Monitoring", "App Center", "Experience Zone"];
const POLL_MS = 1000;

const tabs = document.getElementById("tabs");
const content = document.getElementById("content");
let activeTab = "Home";
let activePage = null;
let lastSnapshot = null;

function renderTabs() {
  tabs.replaceChildren(...TABS.map((name) => {
    const button = document.createElement("button");
    button.className = name === activeTab ? "tab selected" : "tab";
    button.textContent = name;
    button.addEventListener("click", () => selectTab(name));
    return button;
  }));
}

function placeholderPage(name) {
  return {
    mount(container) {
      const placeholder = document.createElement("div");
      placeholder.className = "placeholder";
      placeholder.textContent = name;
      container.replaceChildren(placeholder);
    },
  };
}

function selectTab(name) {
  activePage?.unmount?.();
  activeTab = name;
  renderTabs();
  activePage = (window.NitroPages?.[name] ?? placeholderPage(name));
  activePage.mount(content);
  if (lastSnapshot) activePage.update?.(lastSnapshot);
}

async function poll() {
  // Skip while hidden so a minimized window never keeps the dGPU awake.
  if (!document.hidden) {
    try {
      lastSnapshot = await window.nitro.sensors.snapshot();
      activePage?.update?.(lastSnapshot);
    } catch (error) {
      console.error("sensor snapshot failed", error);
    }
  }
  setTimeout(poll, POLL_MS);
}

document.getElementById("btn-min").addEventListener("click", () => window.nitro.window.minimize());
document.getElementById("btn-max").addEventListener("click", () => window.nitro.window.toggleMaximize());
document.getElementById("btn-close").addEventListener("click", () => window.nitro.window.close());
window.nitro.window.onMaximized((maximized) => document.body.classList.toggle("maximized", maximized));

// Caption glyphs are drawn with one physical pixel, like Windows does.
function updateHairline() {
  document.documentElement.style.setProperty("--hairline", `${1 / window.devicePixelRatio}px`);
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", updateHairline, { once: true });
}

updateHairline();
selectTab(activeTab);
poll();
