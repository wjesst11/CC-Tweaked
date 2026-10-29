const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// localStorage can be unavailable (private windows, blocked storage).
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch {}
  },
};

const MAX_LOGS = 200;
const MAX_TRAIL = 500;
const FACING = ["+Z", "+X", "−Z", "−X"];
const KEYS = { w: "forward", s: "back", a: "turnLeft", d: "turnRight", e: "up", q: "down" };
const DIGGABLE = new Set(["forward", "up", "down"]);
const JOB_NAMES = { quarry: "Quarry", tunnel: "Tunnel", goHome: "Going home" };

// Swatches that make valuables easy to spot in the inventory grid.
const ITEM_COLORS = [
  [/diamond/, "#4ee2e0"],
  [/emerald/, "#17dd62"],
  [/ancient_debris|netherite/, "#6b4a3a"],
  [/gold/, "#f5c542"],
  [/iron/, "#d8af93"],
  [/copper/, "#e07a4f"],
  [/redstone/, "#e02a2a"],
  [/lapis/, "#2f5bd3"],
  [/quartz/, "#e9e3db"],
  [/amethyst/, "#9a5cc6"],
  [/coal/, "#3a3a3a"],
];

const ICONS = {
  offline: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  idle: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>',
  working: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg>',
  attention: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5l4.7 8.8H.3z" fill="currentColor"/></svg>',
};

const savedSelection = store.get("selected");
const state = {
  turtles: new Map(), // id -> turtle as sent by the server, plus logs
  trails: new Map(), // id -> recent [{x, z}] positions for the map
  selected: savedSelection === null ? null : Number(savedSelection),
  ready: false, // received the first snapshot
  ws: null,
  loggedIn: false,
  loginPending: false,
  reconnectDelay: 1000,
};

// Formatting -----------------------------------------------------------------

const nameOf = (t) => t.label || `Turtle #${t.id}`;
const fmt = (n) => Math.round(n).toLocaleString();

function itemsOf(status) {
  const inv = status?.inventory;
  return Array.isArray(inv) ? inv : Object.values(inv ?? {});
}

function prettyName(id) {
  if (!id) return "";
  const name = String(id).replace(/^[^:]+:/, "").replaceAll("_", " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function itemColor(id) {
  return ITEM_COLORS.find(([pattern]) => pattern.test(id))?.[1];
}

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fuelInfo(status) {
  if (status?.fuel == null) return null;
  if (status.fuel === "unlimited") return { unlimited: true };
  const limit = status.fuelLimit > 0 ? status.fuelLimit : 20000;
  const frac = Math.min(1, status.fuel / limit);
  // Severity is absolute: 1,000 fuel is 1,000 blocks whatever the turtle's limit.
  const sev = status.fuel < 200 ? "crit" : status.fuel < 1000 ? "warn" : "ok";
  return { fuel: status.fuel, limit, frac, sev };
}

function jobPercent(job) {
  return job.name === "goHome" ? "" : `${Math.round((job.progress ?? 0) * 100)}%`;
}

function turtleState(t) {
  if (!t.online) return { key: "offline", label: "Offline" };
  const job = t.status?.job;
  if (job && /waiting|full|low on fuel/i.test(job.detail ?? "")) return { key: "attention", label: "Needs attention" };
  if (job) return { key: "working", label: `${JOB_NAMES[job.name] ?? prettyName(job.name)} ${jobPercent(job)}`.trim() };
  if (fuelInfo(t.status)?.sev === "crit") return { key: "attention", label: "Low fuel" };
  return { key: "idle", label: "Idle" };
}

// Connection -----------------------------------------------------------------

function connect(auth) {
  const old = state.ws;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
  state.ws = ws;
  old?.close();
  setConn("connecting");

  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ...auth })));
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.loginPending) {
      state.loginPending = false;
      showLogin("Can't reach the server. Try again.");
      return;
    }
    if (!state.loggedIn) return;
    setConn("offline");
    setTimeout(() => {
      if (state.loggedIn && !state.ws) connect({ session: store.get("session") });
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });
}

function handle(msg) {
  switch (msg.type) {
    case "authOk":
      store.set("session", msg.session);
      state.loggedIn = true;
      state.loginPending = false;
      state.reconnectDelay = 1000;
      showApp();
      setConn("online");
      break;

    case "authFail": {
      const wasPassword = state.loginPending;
      state.loggedIn = false;
      state.loginPending = false;
      store.set("session", null);
      showLogin(wasPassword ? "Wrong password." : "Your session expired. Sign in again.");
      break;
    }

    case "snapshot":
      state.turtles = new Map(msg.turtles.map((t) => [t.id, t]));
      for (const t of state.turtles.values()) recordTrail(t);
      state.ready = true;
      ensureSelection();
      renderAll(true);
      break;

    case "turtle": {
      const hadSelection = state.turtles.has(state.selected);
      const t = { ...msg.turtle, logs: state.turtles.get(msg.turtle.id)?.logs ?? [] };
      state.turtles.set(t.id, t);
      recordTrail(t);
      if (!hadSelection) {
        ensureSelection();
        renderAll(true);
      } else {
        renderList();
        if (t.id === state.selected) renderDetail();
      }
      break;
    }

    case "log": {
      const t = state.turtles.get(msg.id);
      if (!t) break;
      t.logs.push(msg.entry);
      if (t.logs.length > MAX_LOGS) t.logs.shift();
      if (msg.id === state.selected) appendLog(msg.entry);
      if (msg.entry.level !== "info") toast(`${nameOf(t)}: ${msg.entry.msg}`, msg.entry.level);
      break;
    }

    case "removed":
      state.turtles.delete(msg.id);
      state.trails.delete(msg.id);
      ensureSelection();
      renderAll(true);
      break;

    case "error":
      toast(msg.msg, "error");
      break;
  }
}

function sendRaw(msg) {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    toast("Not connected to the server", "error");
    return;
  }
  state.ws.send(JSON.stringify(msg));
}

function command(action, args = {}, id = state.selected) {
  if (id == null) return;
  if (DIGGABLE.has(action) && $("#auto-dig").checked) args = { ...args, dig: true };
  sendRaw({ type: "cmd", id, action, args });
}

// Selection & views ------------------------------------------------------------

function sortedTurtles() {
  return [...state.turtles.values()].sort(
    (a, b) => b.online - a.online || nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }),
  );
}

function ensureSelection() {
  if (state.turtles.has(state.selected)) return;
  state.selected = sortedTurtles()[0]?.id ?? null;
  store.set("selected", state.selected);
}

function select(id) {
  state.selected = id;
  store.set("selected", id);
  renderAll(true);
}

function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
}

function showLogin(error) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !error;
  $("#login-error").textContent = error ?? "";
  $("#login-form button[type=submit]").disabled = false;
  $("#password").focus();
}

function setConn(status) {
  const el = $("#conn");
  el.dataset.state = status;
  el.textContent = { online: "Live", connecting: "Connecting…", offline: "Reconnecting…" }[status];
}

function toast(text, level = "info") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${level}`;
  el.textContent = text;
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), level === "info" ? 3000 : 6000);
}

// Rendering --------------------------------------------------------------------

function renderAll(rebuildLog = false) {
  renderList();
  renderDetail(rebuildLog);
}

function renderStatus(el, st) {
  el.className = `status status-${st.key}`;
  el.innerHTML = ICONS[st.key];
  el.append(st.label);
}

function renderMeter(el, frac, sev = "ok") {
  el.classList.toggle("sev-warn", sev === "warn");
  el.classList.toggle("sev-crit", sev === "crit");
  el.firstElementChild.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
}

function renderList() {
  const list = $("#turtle-list");
  const turtles = sortedTurtles();
  const existing = new Map([...list.children].map((li) => [Number(li.dataset.id), li]));

  turtles.forEach((t, i) => {
    let li = existing.get(t.id);
    existing.delete(t.id);
    if (!li) li = createListItem(t.id);
    updateListItem(li, t);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  for (const li of existing.values()) li.remove();

  const online = turtles.filter((t) => t.online).length;
  $("#list-empty").hidden = turtles.length > 0 || !state.ready;
  $("#turtle-count").textContent = turtles.length ? `${online} of ${turtles.length} online` : "";
}

function createListItem(id) {
  const li = document.createElement("li");
  li.dataset.id = id;
  li.innerHTML = `
    <button class="turtle-item" type="button">
      <span class="ti-top"><span class="ti-name"></span><span class="status"></span></span>
      <span class="meter"><span class="meter-fill"></span></span>
      <span class="ti-sub"></span>
    </button>`;
  li.firstElementChild.addEventListener("click", () => select(id));
  return li;
}

function updateListItem(li, t) {
  const btn = li.firstElementChild;
  const fuel = fuelInfo(t.status);
  btn.setAttribute("aria-current", String(t.id === state.selected));
  $(".ti-name", btn).textContent = nameOf(t);
  renderStatus($(".status", btn), turtleState(t));

  const meter = $(".meter", btn);
  meter.hidden = !fuel || fuel.unlimited;
  if (!meter.hidden) renderMeter(meter, fuel.frac, fuel.sev);

  let sub = "";
  if (!t.online) sub = `Last seen ${ago(t.lastSeen)}`;
  else if (t.status?.job) sub = t.status.job.detail ?? "";
  else if (fuel) sub = fuel.unlimited ? "Unlimited fuel" : `${fmt(fuel.fuel)} fuel`;
  $(".ti-sub", btn).textContent = sub;
}

function renderDetail(rebuildLog = false) {
  const t = state.turtles.get(state.selected);
  $("#empty").hidden = Boolean(t) || !state.ready;
  $("#turtle").hidden = !t;
  if (!t) return;

  const s = t.status ?? {};
  const job = s.job;
  const busy = Boolean(job);

  // Header
  $("#t-name").textContent = nameOf(t);
  renderStatus($("#t-status"), turtleState(t));
  $("#t-meta").textContent = [
    `ID ${t.id}`,
    t.version && `script v${t.version}`,
    !t.online && t.lastSeen && `last seen ${ago(t.lastSeen)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  $("#btn-forget").hidden = t.online;

  // Fuel
  const fuel = fuelInfo(s);
  const fuelMeter = $("#fuel-meter");
  fuelMeter.hidden = !fuel || fuel.unlimited;
  if (!fuel) {
    $("#fuel-value").textContent = "–";
    $("#fuel-sub").textContent = "";
  } else if (fuel.unlimited) {
    $("#fuel-value").textContent = "Unlimited";
    $("#fuel-sub").textContent = "Fuel is turned off on this server";
  } else {
    $("#fuel-value").textContent = fmt(fuel.fuel);
    renderMeter(fuelMeter, fuel.frac, fuel.sev);
    $("#fuel-sub").textContent =
      `${Math.round(fuel.frac * 100)}% of ${fmt(fuel.limit)}` + (fuel.sev === "crit" ? " · refuel soon" : "");
  }

  // Position
  if (s.pos) {
    const [x, y, z] = [s.pos.x, s.pos.y, s.pos.z].map(Number);
    $("#pos-value").innerHTML = `<b>X</b>${x}<b>Y</b>${y}<b>Z</b>${z}`;
    const parts = [`Facing ${FACING[s.heading] ?? "?"}`];
    if (s.home) {
      const dist = Math.abs(x - s.home.x) + Math.abs(y - s.home.y) + Math.abs(z - s.home.z);
      parts.push(dist === 0 ? "At home" : `${dist} blocks from home`);
    }
    if (s.gps) parts.push(`GPS ${[s.gps.x, s.gps.y, s.gps.z].map((n) => Math.round(n)).join(", ")}`);
    $("#pos-sub").textContent = parts.join(" · ");
  } else {
    $("#pos-value").textContent = "–";
    $("#pos-sub").textContent = "";
  }

  // Job
  $("#job-value").textContent = job ? (JOB_NAMES[job.name] ?? prettyName(job.name)) : t.online ? "Idle" : "–";
  $("#btn-stop").hidden = !job && !s.queued;
  $("#job-meter").hidden = !job || job.name === "goHome";
  if (job) renderMeter($("#job-meter"), job.progress ?? 0);
  $("#job-sub").textContent = job
    ? [job.detail, jobPercent(job)].filter(Boolean).join(" · ")
    : s.queued
      ? `${s.queued} command${s.queued === 1 ? "" : "s"} queued`
      : "";

  // Blocks around the turtle (only refreshed while idle)
  for (const side of ["up", "front", "down"]) {
    const el = $(`#around-${side}`);
    const block = s.around?.[side];
    el.textContent = busy ? "…" : block ? prettyName(block) : s.around ? "Air" : "–";
    el.title = block ?? "";
    el.classList.toggle("air", !block);
  }

  renderInventory(s, t.online && !busy);
  renderMap(t);

  for (const el of $$(".needs-online")) el.disabled = !t.online;
  for (const el of $$(".needs-idle")) el.disabled = !t.online || busy;

  if (rebuildLog) renderLog(t);
}

// Inventory ----------------------------------------------------------------------

function buildInventory() {
  const grid = $("#inv-grid");
  for (let slot = 1; slot <= 16; slot++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot empty";
    btn.dataset.slot = slot;
    btn.innerHTML = `<span class="slot-dot"></span><span class="slot-name"></span><span class="slot-num">${slot}</span><span class="slot-count"></span>`;
    btn.addEventListener("click", () => selectSlot(slot));
    grid.append(btn);
  }
}

function renderInventory(status, enabled) {
  const items = new Map(itemsOf(status).map((item) => [item.slot, item]));
  let used = 0;
  let total = 0;
  for (const btn of $("#inv-grid").children) {
    const slot = Number(btn.dataset.slot);
    const item = items.get(slot);
    const color = item && itemColor(item.name);
    if (item) {
      used++;
      total += item.count;
    }
    btn.classList.toggle("empty", !item);
    btn.classList.toggle("selected", status.selected === slot);
    btn.classList.toggle("has-dot", Boolean(color));
    if (color) btn.style.setProperty("--item", color);
    btn.setAttribute("aria-pressed", String(status.selected === slot));
    btn.title = item ? `${item.name} × ${item.count}` : `Slot ${slot} (empty)`;
    btn.disabled = !enabled;
    $(".slot-name", btn).textContent = item ? prettyName(item.name) : "";
    $(".slot-count", btn).textContent = item ? item.count : "";
  }
  $("#inv-summary").textContent = `${used}/16 slots · ${fmt(total)} items`;
}

function selectSlot(slot) {
  const t = state.turtles.get(state.selected);
  if (!t?.status) return;
  t.status.selected = slot; // optimistic; the next status update confirms it
  renderInventory(t.status, true);
  command("select", { slot });
}

// Map ----------------------------------------------------------------------------

function recordTrail(t) {
  const p = t.status?.pos;
  if (!p) return;
  let trail = state.trails.get(t.id);
  if (!trail) state.trails.set(t.id, (trail = []));
  const last = trail.at(-1);
  if (last && last.x === p.x && last.z === p.z) return;
  // A big jump means the position was reset; don't draw a line across it.
  if (last && Math.abs(last.x - p.x) + Math.abs(last.z - p.z) > 6) trail.length = 0;
  trail.push({ x: p.x, z: p.z });
  if (trail.length > MAX_TRAIL) trail.shift();
}

function renderMap(t) {
  const svg = $("#map");
  const size = 240;
  const s = t.status;
  if (!s?.pos) {
    svg.innerHTML = `<text class="map-note" x="120" y="124" text-anchor="middle">No position yet</text>`;
    return;
  }

  const trail = state.trails.get(t.id) ?? [];
  const points = [...trail, s.pos, s.home].filter(Boolean);
  const xs = points.map((p) => Number(p.x));
  const zs = points.map((p) => Number(p.z));
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const span = Math.max(maxX - minX, maxZ - minZ, 10) + 4;
  const scale = size / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const sx = (x) => (size / 2 + (x - cx) * scale).toFixed(1);
  const sy = (z) => (size / 2 - (z - cz) * scale).toFixed(1); // +Z points up

  const step = [1, 2, 5, 10, 25, 50, 100, 250, 500].find((n) => n * scale >= 18) ?? 1000;
  let out = "";
  for (let x = Math.ceil((cx - span / 2) / step) * step; x <= cx + span / 2; x += step) {
    out += `<line class="grid-line" x1="${sx(x)}" x2="${sx(x)}" y1="0" y2="${size}"/>`;
  }
  for (let z = Math.ceil((cz - span / 2) / step) * step; z <= cz + span / 2; z += step) {
    out += `<line class="grid-line" y1="${sy(z)}" y2="${sy(z)}" x1="0" x2="${size}"/>`;
  }

  if (trail.length > 1) {
    out += `<polyline class="trail" points="${trail.map((p) => `${sx(p.x)},${sy(p.z)}`).join(" ")}"/>`;
  }

  if (s.home) {
    const r = Math.max(5, Math.min(9, scale * 0.45));
    const [hx, hy, hz] = [s.home.x, s.home.y, s.home.z].map(Number);
    out += `<rect class="home" x="${sx(hx) - r}" y="${sy(hz) - r}" width="${2 * r}" height="${2 * r}" rx="2">
      <title>Home: ${hx}, ${hy}, ${hz}</title></rect>`;
  }

  const [x, y, z] = [s.pos.x, s.pos.y, s.pos.z].map(Number);
  out += `<g transform="translate(${sx(x)} ${sy(z)}) rotate(${Number(s.heading) * 90})">
    <path class="turtle-mark" d="M0 -10 L8 8 L0 4 L-8 8 Z"/>
    <title>${nameOf(t).replace(/[<&]/g, "")}: ${x}, ${y}, ${z} facing ${FACING[s.heading] ?? "?"}</title></g>`;
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${step} block${step === 1 ? "" : "s"}</text>`;

  svg.innerHTML = out;
}

// Log ----------------------------------------------------------------------------

function logItem(entry) {
  const li = document.createElement("li");
  li.className = `log-${entry.level}`;
  const time = document.createElement("time");
  time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const msg = document.createElement("span");
  msg.textContent = entry.msg;
  li.append(time, msg);
  return li;
}

function renderLog(t) {
  const log = $("#log");
  log.replaceChildren(...t.logs.map(logItem));
  if (!t.logs.length) {
    const li = document.createElement("li");
    li.className = "log-empty";
    li.textContent = "Nothing logged yet.";
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;
}

function appendLog(entry) {
  const log = $("#log");
  $(".log-empty", log)?.remove();
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 12;
  log.append(logItem(entry));
  while (log.children.length > MAX_LOGS) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// Setup --------------------------------------------------------------------------

function setTab(name) {
  for (const tab of $$(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const form of $$(".job-form")) form.hidden = form.dataset.job !== name;
  store.set("jobTab", name);
}

function setupInstallSteps() {
  const cmd = `wget ${location.origin}/turtle.lua startup.lua`;
  for (const list of $$(".install-steps")) {
    list.append($("#install-steps").content.cloneNode(true));
    $(".install-cmd", list).textContent = cmd;
    $(".copy", list).addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        toast("Copied to clipboard");
      } catch {
        toast("Couldn't copy. Select the text instead.", "warn");
      }
    });
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function currentTurtle() {
  return state.turtles.get(state.selected);
}

function bindEvents() {
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("#login-form button[type=submit]").disabled = true;
    $("#login-error").hidden = true;
    state.loginPending = true;
    connect({ password: $("#password").value });
  });

  $("#btn-logout").addEventListener("click", () => {
    state.loggedIn = false;
    store.set("session", null);
    const ws = state.ws;
    state.ws = null;
    ws?.close();
    showLogin();
  });

  $("#btn-theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    store.set("theme", next);
  });

  $("#btn-install").addEventListener("click", () => $("#install-dialog").showModal());
  $("#btn-stop-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "stop" }));
  $("#btn-recall-all").addEventListener("click", () => {
    if (confirm("Stop every turtle's job and send it home?")) sendRaw({ type: "cmd", id: "all", action: "goHome" });
  });

  $("#btn-stop").addEventListener("click", () => command("stop"));
  $("#btn-rename").addEventListener("click", () => {
    const label = prompt("Name this turtle", currentTurtle()?.label ?? "");
    if (label !== null) command("setLabel", { label: label.trim() });
  });
  $("#btn-update").addEventListener("click", () => {
    if (confirm("Download the latest script from this server and reboot the turtle?")) command("update");
  });
  $("#btn-forget").addEventListener("click", () => {
    const t = currentTurtle();
    if (t && confirm(`Remove ${nameOf(t)} from the list? It reappears if it reconnects.`)) {
      sendRaw({ type: "forget", id: t.id });
    }
  });
  $("#btn-reset-pos").addEventListener("click", () => {
    if (confirm("Reset coordinates to 0, 0, 0 facing +Z and make this spot home? Do this after moving the turtle by hand.")) {
      command("resetPosition");
    }
  });

  for (const btn of $$("[data-cmd]")) btn.addEventListener("click", () => command(btn.dataset.cmd));
  for (const tab of $$(".tab")) tab.addEventListener("click", () => setTab(tab.dataset.tab));

  for (const form of $$(".job-form")) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const args = {};
      for (const [key, value] of new FormData(form)) args[key] = Number(value);
      command(form.dataset.job, args);
    });
  }

  $("#auto-dig").checked = store.get("autoDig") === "1";
  $("#auto-dig").addEventListener("change", (event) => store.set("autoDig", event.target.checked ? "1" : null));

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.("input:not([type=checkbox]), select, textarea")) return;
    if ($("#app").hidden || $("#turtle").hidden || $("#install-dialog").open) return;

    if (event.key === "Escape") {
      if (!$("#btn-stop").disabled) command("stop");
      return;
    }
    const key = event.key.toLowerCase();
    if (!KEYS[key]) return;
    event.preventDefault();
    const btn = $(`.pad[data-key="${key}"]`);
    if (btn.disabled) return;
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
    command(KEYS[key]);
  });

  // Keep "last seen" times fresh.
  setInterval(() => {
    renderList();
    if (currentTurtle() && !currentTurtle().online) renderDetail();
  }, 15000);
}

applyTheme(store.get("theme"));
buildInventory();
setupInstallSteps();
setTab(store.get("jobTab") === "tunnel" ? "tunnel" : "quarry");
bindEvents();

const session = store.get("session");
if (session) {
  state.loggedIn = true;
  showApp();
  renderAll();
  connect({ session });
} else {
  showLogin();
}
