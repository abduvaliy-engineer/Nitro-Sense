const TABS = ["Home", "Scenario", "Personal Settings", "Checkup", "Monitoring", "App Center", "Experience Zone"];
const POLL_MS = 2000;
const UNAVAILABLE = "Not available on Linux yet";

const tabs = document.getElementById("tabs");
const content = document.getElementById("content");
let activeTab = "Home";
let activePage = null;
let lastSnapshot = null;

// NitroSense's disabled look (30 % opacity) with the reason on hover, for controls whose page or feature isn't
// built yet: they stay visible so users see the app is still growing, and ignore clicks.
function unavailable(node, reason = UNAVAILABLE) {
  node.classList.add("unavailable");
  node.title = reason;
  node.setAttribute("aria-disabled", "true");
  return node;
}

const hasPage = (name) => Boolean(window.NitroPages?.[name]);

function renderTabs() {
  tabs.replaceChildren(...TABS.map((name) => {
    const button = document.createElement("button");
    button.className = name === activeTab ? "tab selected" : "tab";
    button.textContent = name;
    if (hasPage(name)) button.addEventListener("click", () => selectTab(name));
    else unavailable(button);
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

// options go to the page's mount (Personal Settings takes { focus: section }).
function selectTab(name, options) {
  activePage?.unmount?.();
  activeTab = name;
  renderTabs();
  activePage = (window.NitroPages?.[name] ?? placeholderPage(name));
  activePage.mount(content, options);
  if (lastSnapshot) activePage.update?.(lastSnapshot);
}

let pollTimer = 0;
let polling = false;

async function poll() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  // Skip while hidden so a minimized window never keeps the dGPU awake.
  if (!document.hidden) {
    try {
      lastSnapshot = await window.nitro.sensors.snapshot();
      for (const page of Object.values(window.NitroPages ?? {})) page.collect?.(lastSnapshot);
      activePage?.update?.(lastSnapshot);
      window.NitroWidgetPanel?.update(lastSnapshot);
      window.NitroModeKey?.enforce(lastSnapshot);
    } catch (error) {
      console.error("sensor snapshot failed", error);
    }
  }
  polling = false;
  pollTimer = setTimeout(poll, POLL_MS);
}

// Power-mode changes from anywhere (mode key, other tools, AC plug) refresh immediately.
window.nitro.sensors.onChange(() => poll());

document.getElementById("btn-min").addEventListener("click", () => window.nitro.window.minimize());
document.getElementById("btn-max").addEventListener("click", () => window.nitro.window.toggleMaximize());
document.getElementById("btn-close").addEventListener("click", () => window.nitro.window.close());
window.nitro.window.onMaximized((maximized) => document.body.classList.toggle("maximized", maximized));

// Caption glyphs are drawn with one physical pixel, like Windows does.
function updateHairline() {
  document.documentElement.style.setProperty("--hairline", `${1 / window.devicePixelRatio}px`);
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", updateHairline, { once: true });
}

window.NitroApp = { selectTab, hasPage, unavailable };

// Support and Settings have no page yet.
for (const button of document.querySelectorAll(".header-btn")) unavailable(button);

// Early development: the running version in the corner ("dev" when it runs from a git checkout).
Promise.all([window.nitro.updates.version(), window.nitro.updates.checkout().catch(() => false)])
  .then(([version, checkout]) => {
    document.getElementById("app-version").textContent = `v${version}${checkout ? " dev" : ""}`;
  })
  .catch((error) => console.error("reading the version failed", error));

updateHairline();
selectTab(activeTab);
poll();
// Like NitroSense, show the active profile's lighting when the app opens.
window.NitroScenario.restoreLighting().catch((error) => console.error("restoring lighting failed", error));
