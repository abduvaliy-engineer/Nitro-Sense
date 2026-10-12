// App Sync in the Scenario Manager: the "Add Apps to Link" dialog (NitroSense app-scenario-add-link-dialog)
// and the name/icon/missing lookup for linked apps.
(() => {
  const ACER = "../assets/acer";
  const scenario = window.NitroScenario;
  const FILTER_KEY = "appSync.filter";
  const FILTERS = [["all", "All Apps"], ["game", "Game"]];
  const SORTS = [["alphabet", "Alphabet"], ["installed", "Installation Date"]];

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

  // An app without an icon gets its first letter, like App Shortcut.
  function appIcon(app, className) {
    if (app?.icon) return icon(app.icon, className);
    return el("span", `${className} as-fallback`, (app?.name ?? "?").slice(0, 1).toUpperCase());
  }

  // ---------- linked-app lookup ----------

  const resolved = new Map(); // key → { name, icon, missing, source }

  async function resolve(apps) {
    const unknown = apps.filter((app) => !resolved.has(app.key));
    if (unknown.length) {
      for (const item of await window.nitro.apps.resolve(unknown)) resolved.set(item.key, item);
    }
    return apps.map((app) => ({ ...app, ...resolved.get(app.key) }));
  }

  // ---------- little dialogs ----------

  function littleDialog(title, text, buttons) {
    window.NitroDialog.open({
      size: "468x200",
      title,
      build(body, close) {
        const content = el("div", "scn-dialog-content");
        content.append(el("span", "scn-dialog-text", text));
        const footer = el("div", "ns-dialog-footer");
        footer.append(...buttons.map(([label, aria, action]) => pill(label, aria, () => { close(); action?.(); })));
        body.append(content, footer);
      },
    });
  }

  // ---------- Add Apps to Link ----------

  async function openAddDialog(profileIndex) {
    const state = scenario.state;
    const profile = state.profiles[profileIndex];
    if (!profile) return;
    const owner = new Map(); // key → profile name, for apps linked to other profiles
    state.profiles.forEach((p, i) => i !== profileIndex && p.apps.forEach((app) => owner.set(app.key, p.name)));
    const selected = new Map(profile.apps.map((app) => [app.key, app]));
    let apps = [];
    let filter = { filterBy: "all", sortBy: "alphabet", ...(await window.nitro.settings.get(FILTER_KEY).catch(() => null)) };
    let search = "";

    window.NitroDialog.open({
      size: "468x560",
      title: "Add Apps to Link",
      build(body, close) {
        const content = el("div", "as-dialog");

        const searchRow = el("div", "as-search-row");
        const searchBox = el("div", "as-search");
        const searchIcon = labelled("button", "as-search-icon", "search app");
        searchIcon.append(icon(`${ACER}/scenario/ic_search.svg`));
        const inputBox = el("div", "as-search-input");
        const input = el("input");
        input.type = "text";
        input.spellcheck = false;
        inputBox.append(input);
        const clearBox = el("div", "as-search-clear");
        const clear = labelled("button", "custom-btn", "clear input");
        clear.append(icon(`${ACER}/scenario/ic_close.svg`));
        clear.hidden = true;
        clearBox.append(clear);
        searchBox.append(searchIcon, inputBox, clearBox);
        const refresh = labelled("button", "custom-btn as-refresh", "refresh");
        refresh.append(icon(`${ACER}/widget/ic_refresh.svg`));
        searchRow.append(searchBox, refresh);

        const menus = el("div", "as-menus");
        const filterButton = menuButton(FILTERS, () => filter.filterBy, (value) => { filter.filterBy = value; saveFilter(); render(); }, "set filter by");
        const sortButton = menuButton(SORTS, () => filter.sortBy, (value) => { filter.sortBy = value; saveFilter(); render(); }, "set sort by");
        menus.append(filterButton.root, sortButton.root);

        const linkRow = el("div", "as-link-row");
        const pick = el("button", "as-pick");
        pick.append(el("span", "", "Cannot find app?"));
        const counter = el("div", "as-counter");
        const counterText = el("span");
        counter.append(icon(`${ACER}/widget/checkbox_v.svg`), counterText);
        linkRow.append(pick, counter);

        const gridBox = el("div", "as-grid-box");
        const grid = el("div", "as-grid");
        const loading = el("div", "as-loading");
        const spinner = el("div", "as-spinner");
        loading.append(spinner);
        gridBox.append(grid, loading);

        content.append(searchRow, menus, linkRow, gridBox);
        const footer = el("div", "ns-dialog-footer as-footer");
        footer.append(
          pill("Cancel", "cancel change and close dialog", close),
          pill("Save", "save and close dialog", () => {
            close();
            scenario.setApps(profileIndex, [...selected.values()]).catch((error) => console.error("linking apps failed", error));
          }),
        );
        body.append(content, footer);

        function saveFilter() {
          window.nitro.settings.set(FILTER_KEY, filter);
        }

        function menuButton(options, current, onPick, ariaPrefix) {
          const trigger = labelled("button", "wi-dropdown as-menu", "apps filter menu");
          const text = el("span", "wi-dropdown-text");
          trigger.append(text, el("div", "wi-dropdown-arrow"));
          trigger.addEventListener("click", () => {
            trigger.classList.add("open");
            window.NitroMenu.open(trigger, options.map(([value, label]) => ({
              label,
              active: value === current(),
              ariaLabel: `${ariaPrefix} ${label}`,
              onSelect: () => onPick(value),
            })), { onClose: () => trigger.classList.remove("open") });
          });
          return { root: trigger, render: () => { text.textContent = options.find(([v]) => v === current())[1]; } };
        }

        function toggle(app) {
          if (selected.has(app.key)) selected.delete(app.key);
          else if (selected.size < scenario.APP_LIMIT) selected.set(app.key, ref(app));
          render();
        }

        const ref = (app) => Object.fromEntries(Object.entries(app).filter(([k]) => ["key", "kind", "name", "desktopId", "steamAppId", "path"].includes(k)));

        function tile(app) {
          const cell = el("div", "as-cell");
          const box = el("div", "as-tile");
          box.id = app.name;
          const isSelected = selected.has(app.key);
          const full = selected.size >= scenario.APP_LIMIT;
          box.classList.toggle("selected", isSelected);
          box.classList.toggle("hoverable", !isSelected && !full);
          const otherProfile = owner.get(app.key);
          if (otherProfile && !isSelected) {
            const badge = el("button", "as-badge");
            badge.append(icon(`${ACER}/scenario/appcenter_linked.svg`));
            box.append(badge);
          } else {
            const check = labelled("button", "ns-checkbox as-check", "select");
            check.append(icon(`${ACER}/widget/checkbox_v.svg`));
            check.classList.toggle("checked", isSelected);
            check.disabled = full && !isSelected;
            check.addEventListener("click", (event) => {
              event.stopPropagation();
              toggle(app);
            });
            box.append(check);
          }
          const art = el("div", "as-art");
          const iconBox = el("div", "as-icon");
          iconBox.append(appIcon(app, "as-icon-img"));
          const name = el("div", "as-name");
          name.append(el("p", "", app.name));
          art.append(iconBox, name);
          art.addEventListener("click", () => {
            if (otherProfile && !isSelected) {
              if (full) return;
              // NitroSense asks first; the other profile loses the app when Save is pressed.
              littleDialog("Linked by Other Scenario",
                `This app is already linked by ${otherProfile}. Are you sure to change this link set?`,
                [["Cancel", "close"], ["Confirm", "confirm", () => toggle(app)]]);
              return;
            }
            toggle(app);
          });
          box.append(art);
          cell.append(box);
          return cell;
        }

        function render() {
          filterButton.render();
          sortButton.render();
          counterText.textContent = `${selected.size}/${scenario.APP_LIMIT}`;
          clear.hidden = !search;
          const query = search.toLowerCase();
          const shown = apps
            .filter((app) => filter.filterBy !== "game" || app.game)
            .filter((app) => !query || app.name.toLowerCase().includes(query))
            .sort((a, b) => (filter.sortBy === "installed" ? b.installed - a.installed : 0) || a.name.localeCompare(b.name));
          grid.replaceChildren(...shown.map(tile));
        }

        async function load() {
          loading.hidden = false;
          grid.hidden = true;
          spinner.replaceChildren();
          window.lottie?.loadAnimation({
            container: spinner, renderer: "svg", loop: true, autoplay: true, path: `${ACER}/animation/loading72-NS.json`,
          });
          const started = Date.now();
          apps = await window.nitro.apps.list().catch(() => []);
          // NitroSense shows its loader for at least 1.5 s on a refresh.
          const wait = 1500 - (Date.now() - started);
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          spinner.replaceChildren();
          loading.hidden = true;
          grid.hidden = false;
          render();
        }

        input.addEventListener("input", () => {
          search = input.value;
          render();
        });
        clear.addEventListener("click", () => {
          input.value = "";
          search = "";
          render();
        });
        refresh.addEventListener("click", async () => {
          await window.nitro.apps.refresh();
          resolved.clear();
          load();
        });
        pick.addEventListener("click", async () => {
          const result = await window.nitro.apps.pickFile().catch(() => null);
          if (!result) return;
          if (result.exists) {
            littleDialog("Notification", "This app already exists in the list.", [["OK", "close"]]);
            return;
          }
          apps.push({ ...result.ref, game: false, installed: Date.now(), icon: null });
          filter.filterBy = "all";
          input.value = "";
          search = "";
          if (selected.size < scenario.APP_LIMIT) selected.set(result.ref.key, result.ref);
          render();
          document.getElementById(result.ref.name)?.scrollIntoView({ block: "nearest" });
        });

        render();
        load();
      },
    });
  }

  window.NitroAppSync = { openAddDialog, resolve, appIcon };
})();
