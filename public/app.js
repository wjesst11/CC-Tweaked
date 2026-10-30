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
const RENDER_INTERVAL_MS = 150;
const SCRIPT_VERSION = "1.4.0"; // the turtle script this dashboard expects
const FACING = ["+Z", "+X", "−Z", "−X"]; // local headings
const COMPASS = ["north", "east", "south", "west"];
const SIDES = { north: "North", east: "East", south: "South", west: "West", up: "Above", down: "Below" };
const KEYS = { w: "forward", s: "back", a: "turnLeft", d: "turnRight", e: "up", q: "down" };
const DIGGABLE = new Set(["forward", "up", "down"]);
const JOB_NAMES = { quarry: "Quarry", tunnel: "Tunnel", goHome: "Going home" };
const KIND_NAMES = { branchMine: "Mining a level", areaQuarry: "Quarrying an area" };
const STATE_LABELS = { working: "Working", paused: "Paused", attention: "Needs attention", idle: "Idle", offline: "Offline" };

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
  paused: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1h2.5v8H1.5zM6 1h2.5v8H6z" fill="currentColor"/></svg>',
  attention: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5l4.7 8.8H.3z" fill="currentColor"/></svg>',
};

const savedSelection = store.get("selected");
const state = {
  turtles: new Map(), // id -> turtle as sent by the server, plus logs
  trails: new Map(), // id -> { frame, points: [{x, z}] } for the map
  selected: savedSelection === null ? null : Number(savedSelection),
  view: store.get("view") === "fleet" ? "fleet" : "turtles",
  filter: store.get("filter") ?? "all",
  search: "",
  mapMode: store.get("mapMode") === "fleet" ? "fleet" : "turtle",
  fleet: null, // shared fleet settings from the server
  fleetDirty: false, // the settings form has unsaved edits
  depot: { holder: null, queue: [] },
  picked: new Set(), // turtles picked for a fleet job
  ready: false, // received the first snapshot
  ws: null,
  loggedIn: false,
  loginPending: false,
  reconnectDelay: 1000,
};

// Formatting -----------------------------------------------------------------

const nameOf = (t) => t.label || `Turtle #${t.id}`;
const fmt = (n) => Math.round(n).toLocaleString();
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeXml = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

function itemsOf(status) {
  const inv = status?.inventory;
  return Array.isArray(inv) ? inv : Object.values(inv ?? {});
}

function prettyName(id) {
  if (!id) return "";
  return capital(String(id).replace(/^[^:]+:/, "").replaceAll("_", " "));
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

function jobName(status) {
  const job = status?.job;
  if (!job) return null;
  if (job.name === "fleetJob" || job.name === "resume") return KIND_NAMES[status.fleetJob?.kind] ?? "Fleet job";
  return JOB_NAMES[job.name] ?? prettyName(job.name);
}

function jobPercent(job) {
  return job.name === "goHome" ? "" : `${Math.round((job.progress ?? 0) * 100)}%`;
}

function turtleState(t) {
  if (!t.online) return { key: "offline", label: "Offline" };
  const s = t.status ?? {};
  const job = s.job;
  if (job?.paused) return { key: "paused", label: "Paused" };
  if (job && /waiting|full|low on fuel/i.test(job.detail ?? "")) return { key: "attention", label: "Needs attention" };
  if (job) return { key: "working", label: `${jobName(s)} ${jobPercent(job)}`.trim() };
  if (s.fleetJob?.failed) return { key: "attention", label: "Job failed" };
  if (s.fleetJob?.paused) return { key: "paused", label: "Paused" };
  if (fuelInfo(s)?.sev === "crit") return { key: "attention", label: "Low fuel" };
  return { key: "idle", label: "Idle" };
}

// Can this turtle take a fleet job? Returns null if so, else the reason.
function notReady(t) {
  const s = t.status ?? {};
  if (!t.online) return "offline";
  if (!s.gpsTrusted) return "no GPS facing yet";
  if (s.lane == null) return "no travel lane yet";
  if (s.job) return "busy";
  return null;
}

// Where to draw a turtle: world coordinates once GPS knows its facing,
// otherwise its own frame relative to where it started.
function mapPos(t) {
  const s = t.status;
  const num = (p) => p && { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
  if (s?.world && s.facing) {
    return { frame: "world", ...num(s.world), dir: COMPASS.indexOf(s.facing), home: num(s.homeWorld) };
  }
  if (s?.pos) return { frame: "local", ...num(s.pos), dir: Number(s.heading), home: num(s.home) };
  return null;
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
    if (state.server) state.server.lastSeen = Date.now();
    try {
      handle(msg);
    } catch (err) {
      reportError(err);
    }
  });
  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
    rememberServer();
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
      noteServer(msg.server);
      state.turtles = new Map(msg.turtles.map((t) => [t.id, t]));
      for (const t of state.turtles.values()) recordTrail(t);
      state.depot = msg.depot ?? state.depot;
      state.ready = true;
      state.revealSelected = true;
      ensureSelection();
      invalidate("list", "detail", "log", "fleet");
      setFleet(msg.fleet);
      break;

    case "turtle": {
      const t = { ...msg.turtle, logs: state.turtles.get(msg.turtle.id)?.logs ?? [] };
      state.turtles.set(t.id, t);
      recordTrail(t);
      if (!state.turtles.has(state.selected)) {
        ensureSelection();
        invalidate("log");
      }
      // Other turtles appear on the maps, so the detail view can change too.
      invalidate("list", "detail", "fleet");
      break;
    }

    case "log": {
      const t = state.turtles.get(msg.id);
      if (!t) break;
      t.logs.push(msg.entry);
      if (t.logs.length > MAX_LOGS) t.logs.shift();
      if (msg.id === state.selected && !dirty.log) appendLog(msg.entry);
      if (msg.entry.level !== "info") toast(`${nameOf(t)}: ${msg.entry.msg}`, msg.entry.level);
      break;
    }

    case "removed":
      state.turtles.delete(msg.id);
      state.trails.delete(msg.id);
      state.picked.delete(msg.id);
      ensureSelection();
      invalidate("list", "detail", "log", "fleet");
      break;

    case "fleet":
      setFleet(msg.fleet);
      invalidate("fleet");
      break;

    case "depot":
      state.depot = msg.depot;
      invalidate("fleet");
      break;

    case "fleetSaved":
      if (msg.ok) {
        state.fleetDirty = false;
        fillFleetForm();
      }
      setSaveMsg(msg.ok ? "Saved. Every turtle has the new settings." : msg.msg, !msg.ok);
      break;

    case "fleetJobResult": {
      const el = $("#fleet-job-result");
      el.hidden = false;
      el.className = `form-msg ${msg.ok ? "ok" : "error"}`;
      el.textContent = msg.msg;
      break;
    }

    case "error":
      toast(msg.msg, "error");
      break;
  }
}

// Something went wrong in the dashboard itself: say so once instead of
// silently showing stale or missing turtles.
function reportError(err) {
  console.error(err);
  if (state.reportedError) return;
  state.reportedError = true;
  toast(`Dashboard error: ${err?.message ?? err}. Reload the page, and report it if it keeps happening.`, "error");
}

// Which copy of the server we talk to is remembered across page loads. A
// different copy running the same code that was already up while we were
// talking to the previous one means two copies are running side by side,
// which splits turtles and dashboards between them.
function noteServer(server) {
  if (!server) return;
  let prev = null;
  try {
    prev = JSON.parse(store.get("server") ?? "null");
  } catch {}
  const twoCopies =
    prev && prev.instance !== server.instance && prev.build === server.build && server.startedAt < prev.lastSeen - 5000;
  if (twoCopies) $("#server-warning").hidden = false;
  state.server = { ...server, lastSeen: Date.now() };
  rememberServer();
}

function rememberServer() {
  if (state.server) store.set("server", JSON.stringify(state.server));
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

// Rendering is batched: with dozens of turtles streaming updates, draw at most
// every RENDER_INTERVAL_MS rather than once per message.
const dirty = { list: false, detail: false, log: false, fleet: false };
let renderTimer = 0;
let lastRender = 0;

function invalidate(...parts) {
  for (const part of parts) dirty[part] = true;
  if (renderTimer) return;
  const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRender));
  renderTimer = setTimeout(() => requestAnimationFrame(flush), wait);
}

function flush() {
  renderTimer = 0;
  lastRender = performance.now();
  const { list, detail, log, fleet } = dirty;
  dirty.list = dirty.detail = dirty.log = dirty.fleet = false;
  try {
    if (list) renderList();
    $("#fleet-view").hidden = state.view !== "fleet";
    if (state.view === "fleet") {
      $("#turtle").hidden = $("#empty").hidden = true;
      if (fleet || list) renderFleet();
    } else if (detail || log) {
      renderDetail(log);
    }
  } catch (err) {
    reportError(err);
  }
}

// Renaming ------------------------------------------------------------------------
// A turtle's name is its computer label, stored on the turtle. Names are never
// cleared: an unlabeled turtle loses its files when it's picked up.

function renameTurtle(t, label) {
  const taken = [...state.turtles.values()].find((o) => o.id !== t.id && nameOf(o).toLowerCase() === label.toLowerCase());
  if (taken) toast(`Turtle #${taken.id} is also called ${label}.`, "warn");
  sendRaw({ type: "cmd", id: t.id, action: "setLabel", args: { label } });
  t.label = label; // shown right away; the turtle's next status confirms it
  invalidate("list", "detail", "fleet");
}

function startRename() {
  const t = currentTurtle();
  if (!t?.online) return;
  $("#rename-input").value = t.label ?? "";
  $(".name-row").hidden = true;
  $("#rename-form").hidden = false;
  $("#rename-input").focus();
  $("#rename-input").select();
}

function endRename() {
  $("#rename-form").hidden = true;
  $(".name-row").hidden = false;
}

// Picked turtles in ID order, each with its new name.
function bulkRenamePlan() {
  const form = $("#bulk-rename");
  const prefix = form.elements.prefix.value.trim();
  const start = Math.max(0, Math.floor(Number(form.elements.start.value) || 0));
  return pickedTurtles()
    .sort((a, b) => a.id - b.id)
    .map((t, i) => ({ t, label: `${prefix}${start + i}` }));
}

function renderBulkRenamePreview() {
  const plan = bulkRenamePlan();
  const offline = plan.filter((p) => !p.t.online).length;
  const sample = plan.slice(0, 3).map((p) => `${nameOf(p.t)} → ${p.label}`).join(", ");
  $("#bulk-rename-preview").textContent = plan.length
    ? `${plan.length} turtle${plan.length === 1 ? "" : "s"} in ID order: ${sample}${plan.length > 3 ? ", …" : ""}.` +
      (offline ? ` ${offline} offline turtle${offline === 1 ? "" : "s"} will be skipped.` : "")
    : "Pick turtles above first.";
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
  endRename();
  state.selected = id;
  state.revealSelected = true;
  store.set("selected", id);
  invalidate("list", "detail", "log", "fleet");
}

function setView(view) {
  state.view = view;
  store.set("view", view);
  for (const tab of $$(".tab[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  invalidate("list", "detail", "log", "fleet");
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

function currentTurtle() {
  return state.turtles.get(state.selected);
}

// Turtle list --------------------------------------------------------------------

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

function matchesSearch(t, query) {
  if (!query) return true;
  const q = query.toLowerCase().replace(/^#/, "");
  return nameOf(t).toLowerCase().includes(q) || String(t.id) === q;
}

function renderList() {
  const turtles = sortedTurtles();
  const states = new Map(turtles.map((t) => [t.id, turtleState(t)]));

  const counts = { all: turtles.length, working: 0, paused: 0, attention: 0, idle: 0, offline: 0 };
  for (const st of states.values()) counts[st.key]++;
  for (const chip of $$(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === state.filter));
    chip.lastElementChild.textContent = counts[chip.dataset.filter];
  }

  const visible = turtles.filter(
    (t) => (state.filter === "all" || states.get(t.id).key === state.filter) && matchesSearch(t, state.search),
  );

  const list = $("#turtle-list");
  const existing = new Map([...list.children].map((li) => [Number(li.dataset.id), li]));
  visible.forEach((t, i) => {
    let li = existing.get(t.id);
    existing.delete(t.id);
    if (!li) li = createListItem(t.id);
    updateListItem(li, t, states.get(t.id));
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  for (const li of existing.values()) li.remove();

  const selectedLi = state.revealSelected && list.querySelector(`li[data-id="${state.selected}"]`);
  state.revealSelected = false;
  if (selectedLi) {
    // Scroll the list only (scrollIntoView would also jump the page on phones).
    const l = list.getBoundingClientRect();
    const r = selectedLi.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
    if (r.left < l.left || r.right > l.right) list.scrollLeft += r.left - l.left;
  }

  const empty = $("#list-empty");
  empty.hidden = visible.length > 0 || !state.ready;
  empty.textContent = turtles.length ? "No turtles match." : "No turtles have connected yet.";
  $("#turtle-count").textContent = turtles.length ? `${turtles.length - counts.offline} of ${turtles.length} online` : "";
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

function updateListItem(li, t, st) {
  const btn = li.firstElementChild;
  const fuel = fuelInfo(t.status);
  btn.setAttribute("aria-current", String(t.id === state.selected));
  $(".ti-name", btn).textContent = nameOf(t);
  renderStatus($(".status", btn), st);

  const meter = $(".meter", btn);
  meter.hidden = !fuel || fuel.unlimited;
  if (!meter.hidden) renderMeter(meter, fuel.frac, fuel.sev);

  let sub = "";
  if (!t.online) sub = `Last seen ${ago(t.lastSeen)}`;
  else if (t.status?.job) sub = t.status.job.detail ?? "";
  else if (t.status?.fleetJob?.failed) sub = t.status.fleetJob.failed;
  else if (fuel) sub = fuel.unlimited ? "Unlimited fuel" : `${fmt(fuel.fuel)} fuel`;
  $(".ti-sub", btn).textContent = sub;
}

// Turtle detail --------------------------------------------------------------------

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

  renderFuel(s);
  renderPosition(s);
  renderJob(s);

  renderLocalPlan(t);

  // Blocks around the turtle (only refreshed while idle)
  for (const side of ["up", "front", "down"]) {
    const el = $(`#around-${side}`);
    const block = s.around?.[side];
    el.textContent = busy ? "…" : block ? prettyName(block) : s.around ? "Air" : "–";
    el.title = block ?? "";
    el.classList.toggle("air", !block);
  }

  renderInventory(s, t.online && !busy);
  renderHome(s);
  renderMap(t);

  for (const el of $$(".needs-online")) el.disabled = !t.online;
  for (const el of $$(".needs-idle")) el.disabled = !t.online || busy;

  if (rebuildLog) renderLog(t);
}

function renderFuel(s) {
  const fuel = fuelInfo(s);
  const meter = $("#fuel-meter");
  meter.hidden = !fuel || fuel.unlimited;
  if (!fuel) {
    $("#fuel-value").textContent = "–";
    $("#fuel-sub").textContent = "";
  } else if (fuel.unlimited) {
    $("#fuel-value").textContent = "Unlimited";
    $("#fuel-sub").textContent = "Fuel is turned off on this server";
  } else {
    $("#fuel-value").textContent = fmt(fuel.fuel);
    renderMeter(meter, fuel.frac, fuel.sev);
    $("#fuel-sub").textContent =
      `${Math.round(fuel.frac * 100)}% of ${fmt(fuel.limit)}` + (fuel.sev === "crit" ? " · refuel soon" : "");
  }
}

function coordsHtml(p) {
  const [x, y, z] = [p.x, p.y, p.z].map((n) => Math.round(Number(n)));
  return `<b>X</b>${x}<b>Y</b>${y}<b>Z</b>${z}`;
}

function renderPosition(s) {
  const world = s.world ?? s.gps; // script v1.0 sent `gps`
  const parts = [];
  if (world) {
    $("#pos-label").textContent = "Position · GPS";
    $("#pos-value").innerHTML = coordsHtml(world);
    parts.push(s.facing ? `Facing ${capital(s.facing)}` : "Move one block so it can find north");
  } else if (s.pos) {
    $("#pos-label").textContent = "Position · relative to start";
    $("#pos-value").innerHTML = coordsHtml(s.pos);
    parts.push(`Facing ${FACING[s.heading] ?? "?"}`);
    if (s.gpsState === "none") parts.push("no wireless modem");
    if (s.gpsState === "nofix") parts.push("no GPS signal");
  } else {
    $("#pos-label").textContent = "Position";
    $("#pos-value").textContent = "–";
  }
  if (s.pos && s.home) {
    const dist = Math.abs(s.pos.x - s.home.x) + Math.abs(s.pos.y - s.home.y) + Math.abs(s.pos.z - s.home.z);
    parts.push(dist === 0 ? "At home" : `${fmt(dist)} blocks from home`);
  }
  $("#pos-sub").textContent = parts.join(" · ");
}

function renderJob(s) {
  const job = s.job;
  const fj = s.fleetJob;
  const waiting = !job && fj && (fj.paused || fj.failed); // a fleet job that stopped
  $("#btn-pause").hidden = !(job && !job.paused);
  $("#btn-resume").hidden = !(job?.paused || waiting);
  $("#btn-cancel").hidden = !(job || fj);

  let value = "Idle";
  let sub = s.queued ? `${s.queued} command${s.queued === 1 ? "" : "s"} queued` : "";
  if (job) {
    value = job.paused ? `${jobName(s)} (paused)` : jobName(s);
    sub = [job.detail, jobPercent(job)].filter(Boolean).join(" · ");
  } else if (waiting) {
    value = fj.failed ? "Fleet job stopped" : "Fleet job paused";
    sub = fj.failed ?? `${KIND_NAMES[fj.kind] ?? "Fleet job"}, step ${fj.step} of ${fj.total}`;
  }
  $("#job-value").textContent = value;
  $("#job-meter").hidden = !job || job.name === "goHome";
  if (job) renderMeter($("#job-meter"), job.progress ?? 0);
  $("#job-sub").textContent = sub;
}

function renderHome(s) {
  const el = $("#home-line");
  const w = s.homeWorld;
  if (w) {
    el.innerHTML = `Home <b>${[w.x, w.y, w.z].map(Number).join(", ")}</b>` + (s.homeFacing ? ` facing ${s.homeFacing}` : "");
  } else if (s.home) {
    el.innerHTML = `Home <b>${[s.home.x, s.home.y, s.home.z].map(Number).join(", ")}</b> (relative to start)`;
  } else {
    el.textContent = "";
  }
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

// Planned jobs -----------------------------------------------------------------------
// What a job would dig, worked out before it starts, so it can be shown in
// words and outlined on the maps.

const WORLD_STEP = { x: [0, 1, 0, -1], z: [-1, 0, 1, 0] }; // by compass direction
const LOCAL_STEP = { x: [0, 1, 0, -1], z: [1, 0, -1, 0] }; // by local heading

function localJobTab() {
  return $(".tab[data-tab][aria-selected=true]")?.dataset.tab ?? "quarry";
}

// The box a local job started now would dig, in the map's frame (world when
// GPS knows the facing, otherwise relative to where the turtle started).
function plannedLocalJob(t) {
  const me = mapPos(t);
  if (!me) return null;
  const tab = localJobTab();
  const form = $(`.job-form[data-job="${tab}"]`);
  // namedItem: a field called "length" would otherwise read the form's field count.
  const value = (name) => Number(form.elements.namedItem(name)?.value);
  const step = me.frame === "world" ? WORLD_STEP : LOCAL_STEP;
  const f = { x: step.x[me.dir], z: step.z[me.dir] };
  const r = { x: step.x[(me.dir + 1) % 4], z: step.z[(me.dir + 1) % 4] };
  if (tab === "quarry") {
    const [length, width, depth] = [value("length"), value("width"), value("depth")];
    if (!(length > 0 && width > 0 && depth > 0)) return null;
    return {
      frame: me.frame, tab, length, width, depth,
      x1: me.x, z1: me.z,
      x2: me.x + (length - 1) * f.x + (width - 1) * r.x,
      z2: me.z + (length - 1) * f.z + (width - 1) * r.z,
      yTop: me.y - 1, yBottom: me.y - depth,
    };
  }
  const length = value("length");
  if (!(length > 0)) return null;
  const height = value("height") || 2;
  return {
    frame: me.frame, tab, length, height,
    x1: me.x + f.x, z1: me.z + f.z, x2: me.x + length * f.x, z2: me.z + length * f.z,
    yTop: me.y + height - 1, yBottom: me.y,
  };
}

const span = (a, b) => (a === b ? `${a}` : `${Math.min(a, b)} to ${Math.max(a, b)}`);

function renderLocalPlan(t) {
  const s = t.status ?? {};
  const facing = s.facing;
  const right = facing && COMPASS[(COMPASS.indexOf(facing) + 1) % 4];
  for (const el of $$("[data-dir-label]")) {
    const dir = el.dataset.dirLabel === "forward" ? facing : right;
    el.textContent = capital(el.dataset.dirLabel) + (dir ? ` (${dir})` : "");
  }
  const plan = plannedLocalJob(t);
  const line = $(`.job-form[data-job="${localJobTab()}"] [data-plan]`);
  if (!plan) {
    line.textContent = "";
    return;
  }
  const where = plan.frame === "world"
    ? `X <b>${span(plan.x1, plan.x2)}</b>, Z <b>${span(plan.z1, plan.z2)}</b>, ` +
      (plan.yTop === plan.yBottom ? `Y <b>${plan.yTop}</b>` : `from Y <b>${plan.yTop}</b> down to <b>${plan.yBottom}</b>`)
    : null;
  line.innerHTML = plan.tab === "quarry"
    ? (where
      ? `Digs ${where}: ${plan.length} ${facing}, ${plan.width} ${right} and ${plan.depth} down, starting under the turtle. Stops early at bedrock.`
      : `Digs ${plan.length} forward, ${plan.width} to the right and ${plan.depth} down, starting under the turtle. Stops early at bedrock.`)
    : (where
      ? `Digs ${where}: ${plan.length} blocks ${facing}, ${plan.height} high.`
      : `Digs ${plan.length} blocks straight ahead, ${plan.height} high.`);
}

// The areas a fleet job started now would dig, in world coordinates.
function plannedFleetJob() {
  const { kind, params: p } = fleetParams();
  if (kind === "areaQuarry") {
    if ([p.x1, p.z1, p.x2, p.z2].some((v) => v == null)) return [];
    return [{ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, label: `Planned quarry, Y ${span(p.yTop ?? "?", p.yBottom ?? "?")}` }];
  }
  if ([p.x, p.z, p.length, p.spacing].some((v) => v == null) || !(p.length > 0)) return [];
  const dir = COMPASS.indexOf(p.dir);
  const right = (dir + 1) % 4;
  const n = Math.max(1, pickedTurtles().filter((t) => !notReady(t)).length);
  return Array.from({ length: n }, (_, k) => {
    const x = p.x + k * p.spacing * WORLD_STEP.x[right];
    const z = p.z + k * p.spacing * WORLD_STEP.z[right];
    return {
      x1: x, z1: z, x2: x + (p.length - 1) * WORLD_STEP.x[dir], z2: z + (p.length - 1) * WORLD_STEP.z[dir],
      label: `Planned tunnel ${k + 1} at Y ${p.y ?? "?"}`,
    };
  });
}

// Map ----------------------------------------------------------------------------

function recordTrail(t) {
  const p = mapPos(t);
  if (!p) return;
  let trail = state.trails.get(t.id);
  if (!trail || trail.frame !== p.frame) state.trails.set(t.id, (trail = { frame: p.frame, points: [] }));
  const points = trail.points;
  const last = points.at(-1);
  if (last && last.x === p.x && last.z === p.z) return;
  // A big jump means the position was reset or recalibrated; don't draw a line across it.
  if (last && Math.abs(last.x - p.x) + Math.abs(last.z - p.z) > 6) points.length = 0;
  points.push({ x: p.x, z: p.z });
  if (points.length > MAX_TRAIL) points.shift();
}

function arrow(cls, x, y, dir, size) {
  const k = size / 10;
  return `<path class="${cls}" transform="translate(${x} ${y}) rotate(${(Number(dir) || 0) * 90}) scale(${k})" d="M0 -10 L8 8 L0 4 L-8 8 Z"/>`;
}

// A square view fitted around the given points, with world (north-up) or
// local (start-direction-up) orientation.
function viewport(points, size, world, minSpan = 10) {
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const span = Math.max(maxX - minX, maxZ - minZ, minSpan) * 1.15 + 4;
  const scale = size / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const v = {
    size, span, scale, cx, cz,
    sx: (x) => +(size / 2 + (x - cx) * scale).toFixed(1),
    sy: (z) => +(size / 2 + (world ? 1 : -1) * (z - cz) * scale).toFixed(1),
    inView: (p) => Math.abs(p.x - cx) <= span / 2 && Math.abs(p.z - cz) <= span / 2,
  };
  v.step = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].find((n) => n * scale >= 18) ?? 10000;
  return v;
}

function gridLines(v) {
  let out = "";
  const { size, span, cx, cz, step } = v;
  for (let x = Math.ceil((cx - span / 2) / step) * step; x <= cx + span / 2; x += step) {
    out += `<line class="grid-line" x1="${v.sx(x)}" x2="${v.sx(x)}" y1="0" y2="${size}"/>`;
  }
  for (let z = Math.ceil((cz - span / 2) / step) * step; z <= cz + span / 2; z += step) {
    out += `<line class="grid-line" y1="${v.sy(z)}" y2="${v.sy(z)}" x1="0" x2="${size}"/>`;
  }
  return out;
}

// World-space rectangle (inclusive block coordinates) as an SVG rect.
function rect(v, x1, z1, x2, z2, cls, title) {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2) + 1];
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2) + 1];
  const left = v.sx(ax - 0.5);
  const top = v.sy(az - 0.5);
  const w = Math.max(2, v.sx(bx - 0.5) - left);
  const h = Math.max(2, v.sy(bz - 0.5) - top);
  return `<rect class="${cls}" x="${left}" y="${top}" width="${w}" height="${h}"><title>${escapeXml(title)}</title></rect>`;
}

function renderMap(t) {
  const svg = $("#map");
  const size = 240;
  const fleet = state.mapMode === "fleet";
  const me = mapPos(t);
  const mine = me && (!fleet || me.frame === "world") ? me : null;
  const world = fleet || me?.frame === "world";
  const others = world
    ? sortedTurtles()
        .filter((o) => o.id !== t.id)
        .map((o) => ({ t: o, p: mapPos(o) }))
        .filter((o) => o.p?.frame === "world")
    : [];
  renderLegend(fleet, world);

  if (!mine && !(fleet && others.length)) {
    const note = fleet ? "No GPS positions yet" : "No position yet";
    svg.innerHTML = `<text class="map-note" x="120" y="124" text-anchor="middle">${note}</text>`;
    return;
  }

  const trail = mine ? (state.trails.get(t.id)?.points ?? []) : [];
  const plan = !fleet && t.online && !t.status?.job ? plannedLocalJob(t) : null;
  const fit = fleet ? [...others.map((o) => o.p), mine] : [...trail, mine, mine.home];
  if (plan) fit.push({ x: plan.x1, z: plan.z1 }, { x: plan.x2, z: plan.z2 });
  const v = viewport(fit.filter(Boolean), size, world);
  let out = gridLines(v);
  if (plan) out += rect(v, plan.x1, plan.z1, plan.x2, plan.z2, "plan", `Planned ${plan.tab}`);

  if (trail.length > 1) {
    out += `<polyline class="trail" points="${trail.map((p) => `${v.sx(p.x)},${v.sy(p.z)}`).join(" ")}"/>`;
  }

  if (mine?.home && !fleet) {
    const h = mine.home;
    const r = Math.max(5, Math.min(9, v.scale * 0.45));
    out += `<rect class="home" x="${v.sx(h.x) - r}" y="${v.sy(h.z) - r}" width="${2 * r}" height="${2 * r}" rx="2">
      <title>Home: ${[h.x, h.y, h.z].join(", ")}</title></rect>`;
  }

  // Other turtles: status-colored and clickable in fleet view, faint context otherwise.
  for (const { t: o, p } of others) {
    if (!v.inView(p)) continue;
    const st = turtleState(o);
    const title = `<title>${escapeXml(nameOf(o))} · ${st.label} · ${p.x}, ${p.y}, ${p.z}</title>`;
    out += fleet
      ? `<g class="pick-mark" data-id="${o.id}">${arrow(`mark mark-${st.key}`, v.sx(p.x), v.sy(p.z), p.dir, 7)}${title}</g>`
      : `<g class="pick-mark" data-id="${o.id}"><circle class="other" cx="${v.sx(p.x)}" cy="${v.sy(p.z)}" r="3.5"/>${title}</g>`;
  }

  if (mine) {
    const st = turtleState(t);
    const [x, y] = [v.sx(mine.x), v.sy(mine.z)];
    const facing = mine.frame === "world" ? capital(COMPASS[mine.dir] ?? "?") : FACING[mine.dir];
    if (fleet) out += `<circle class="selected-ring" cx="${x}" cy="${y}" r="13"/>`;
    out += `<g>${arrow(fleet ? `mark mark-${st.key}` : "turtle-mark", x, y, mine.dir, 10)}
      <title>${escapeXml(nameOf(t))}: ${mine.x}, ${mine.y}, ${mine.z} facing ${facing}</title></g>`;
    if (fleet) {
      const anchor = x > size - 70 ? "end" : "start";
      out += `<text class="map-label" x="${x + (anchor === "end" ? -16 : 16)}" y="${y + 4}" text-anchor="${anchor}">${escapeXml(nameOf(t))}</text>`;
    }
  }

  out += `<text class="compass" x="${size - 8}" y="16" text-anchor="end">${world ? "N ↑" : "↑ start direction"}</text>`;
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${fmt(v.step)} block${v.step === 1 ? "" : "s"}</text>`;
  svg.innerHTML = out;
}

function renderLegend(fleet, world) {
  const key = fleet ? "fleet" : world ? "world" : "local";
  const legend = $("#map-legend");
  if (legend.dataset.key === key) return;
  legend.dataset.key = key;
  legend.innerHTML = fleet
    ? Object.entries(STATE_LABELS)
        .map(([k, label]) => `<li><span class="key key-mark mark-${k}"></span>${label}</li>`)
        .join("") + `<li><span class="key key-ring"></span>Selected</li>`
    : `<li><span class="key key-turtle"></span>Turtle</li>
       <li><span class="key key-home"></span>Home</li>
       <li><span class="key key-trail"></span>Path</li>` +
      (world ? `<li><span class="key key-other"></span>Other turtles</li>` : "");
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

// Fleet page --------------------------------------------------------------------

function jobBox(args) {
  if (args?.kind === "areaQuarry") return { x1: args.x1, z1: args.z1, x2: args.x2, z2: args.z2 };
  if (args?.kind === "branchMine") {
    const d = COMPASS.indexOf(args.dir);
    const dir = d >= 0 ? d : Number(args.dir) || 0;
    const ex = args.x + (args.length - 1) * [0, 1, 0, -1][dir];
    const ez = args.z + (args.length - 1) * [-1, 0, 1, 0][dir];
    return { x1: args.x, z1: args.z, x2: ex, z2: ez };
  }
  return null;
}

function renderFleet() {
  const turtles = sortedTurtles();
  const f = state.fleet ?? {};
  const states = turtles.map(turtleState);
  const count = (key) => states.filter((s) => s.key === key).length;
  $("#fleet-summary").textContent = turtles.length
    ? [
        `${turtles.length} turtles`,
        `${turtles.length - count("offline")} online`,
        `${count("working")} working`,
        count("paused") && `${count("paused")} paused`,
        count("attention") && `${count("attention")} need attention`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No turtles yet";

  renderFleetWarnings(turtles, f);
  renderPicker(turtles);
  renderFleetPreview();
  renderDepotStatus();
  renderFleetMap(turtles, f);

  const sel = currentTurtle();
  const selName = sel ? nameOf(sel) : null;
  for (const btn of $$("[data-use-pos]")) {
    btn.disabled = !sel?.status?.world;
    btn.title = sel ? `Use ${selName}'s position` : "Select a turtle in the list first";
  }
  $("#btn-dock-here").disabled = !sel?.status?.world;
  $("#btn-dock-here").textContent = selName ? `Dock at ${selName}'s position` : "Dock at selected turtle";
  $("#btn-release-dock").disabled = state.depot.holder == null;
}

function renderFleetWarnings(turtles, f) {
  const notes = [];
  if (!f.depot) notes.push("Set up the depot below before starting fleet jobs.");
  const old = turtles.filter((t) => t.online && t.version && t.version < SCRIPT_VERSION);
  if (old.length) notes.push(`${old.length} turtle${old.length === 1 ? " runs" : "s run"} an older script. Use Update all scripts.`);
  const byHome = new Map();
  for (const t of turtles) {
    const h = t.status?.homeWorld;
    if (!h) continue;
    const key = `${h.x},${h.y},${h.z}`;
    byHome.set(key, [...(byHome.get(key) ?? []), nameOf(t)]);
  }
  for (const [key, names] of byHome) {
    if (names.length > 1) notes.push(`${names.join(", ")} share a home at ${key.replaceAll(",", ", ")}. Give each its own with Set home.`);
  }
  const el = $("#fleet-warnings");
  el.hidden = !notes.length;
  el.replaceChildren(...notes.map((n) => Object.assign(document.createElement("div"), { textContent: n })));
}

function renderPicker(turtles) {
  const box = $("#picker");
  const existing = new Map([...box.children].map((el) => [Number(el.dataset.id), el]));
  turtles.forEach((t, i) => {
    let el = existing.get(t.id);
    existing.delete(t.id);
    if (!el) {
      el = document.createElement("label");
      el.className = "pick";
      el.dataset.id = t.id;
      el.innerHTML = `<input type="checkbox"><span class="status-dot"></span><span class="pick-name"></span>`;
      $("input", el).addEventListener("change", (e) => {
        if (e.target.checked) state.picked.add(t.id);
        else state.picked.delete(t.id);
        renderFleetPreview();
        invalidate("fleet");
      });
    }
    const st = turtleState(t);
    const reason = notReady(t);
    el.classList.toggle("unready", Boolean(reason));
    el.style.setProperty("--tone", `var(--${{ working: "accent", paused: "ink-2", attention: "warning", idle: "good", offline: "muted" }[st.key]})`);
    $(".status-dot", el).innerHTML = ICONS[st.key];
    $(".pick-name", el).textContent = nameOf(t);
    el.title = `${nameOf(t)}: ${st.label}${reason ? ` (${reason})` : ""}`;
    $("input", el).checked = state.picked.has(t.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
  });
  for (const el of existing.values()) el.remove();
}

function pickedTurtles() {
  return [...state.picked].map((id) => state.turtles.get(id)).filter(Boolean);
}

function fleetTab() {
  return $(".tab[data-fleet-tab][aria-selected=true]")?.dataset.fleetTab ?? "branchMine";
}

function fleetParams() {
  const kind = fleetTab();
  const form = $("#fleet-job-form");
  const params = {};
  for (const el of $$(`[data-kind="${kind}"] [name]`, form)) {
    if (el.name === "preset" || el.name === "bottomPreset") continue;
    params[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value;
  }
  return { kind, params };
}

function renderFleetPreview() {
  const picked = pickedTurtles();
  const ready = picked.filter((t) => !notReady(t));
  $("#picker-count").textContent = `${picked.length} picked${picked.length !== ready.length ? `, ${ready.length} ready` : ""}`;
  const { kind, params: p } = fleetParams();
  let text = "";
  if (!ready.length) {
    text = "Pick the turtles to send. Only online, idle turtles that know their GPS facing can start.";
  } else if (kind === "branchMine") {
    if (p.x != null && p.z != null && p.y != null && p.length) {
      const n = ready.length;
      text = `${n} tunnel${n === 1 ? "" : "s"}, ${p.length} blocks long at Y ${p.y}, heading ${p.dir} from ${p.x}, ${p.z}` +
        (n > 1 ? `, ${p.spacing} apart going ${COMPASS[(COMPASS.indexOf(p.dir) + 1) % 4]}.` : ".");
    } else {
      text = "Fill in the start position and level.";
    }
  } else if ([p.x1, p.z1, p.x2, p.z2, p.yTop, p.yBottom].every((v) => v != null)) {
    const w = Math.abs(p.x2 - p.x1) + 1;
    const l = Math.abs(p.z2 - p.z1) + 1;
    const h = Math.abs(p.yTop - p.yBottom) + 1;
    const strips = Math.min(ready.length, Math.max(w, l));
    text = `Digs X ${span(p.x1, p.x2)}, Z ${span(p.z1, p.z2)}, from Y ${Math.max(p.yTop, p.yBottom)} down to Y ${Math.min(p.yTop, p.yBottom)}: ` +
      `${w} × ${l} × ${h} (${fmt(w * l * h)} blocks), split into ${strips} strip${strips === 1 ? "" : "s"}. Outlined on the map.`;
  } else {
    text = "Set both corners (stand a turtle on each and click At turtle) and the top and bottom Y.";
  }
  $("#fleet-job-preview").textContent = text;
  if (!$("#bulk-rename").hidden) renderBulkRenamePreview();
}

// Which way turtles get into the dock, from the sides picked in the form (it
// mirrors dockApproach in fleet.js).
function renderDockApproach() {
  const side = (field) => $(`[data-field="depot.${field}"]`).value;
  const used = new Set([side("junk"), side("valuables"), side("fuel")]);
  const el = $("#dock-approach");
  if (used.size < 3) {
    el.textContent = "Each chest needs its own side of the dock.";
  } else if (!used.has("up")) {
    el.textContent = "Turtles come straight down into the dock, so keep the sky above it open.";
  } else {
    const entry = ["south", "north", "west"].find((s) => !used.has(s));
    el.textContent = `With a chest above the dock, turtles come down the column on its ${entry} side and step in sideways, so keep the sky above that block open.`;
  }
}

function renderDepotStatus() {
  const { holder, queue = [] } = state.depot;
  const name = (id) => {
    const t = state.turtles.get(id);
    return t ? nameOf(t) + (t.online ? "" : " (offline)") : `#${id}`;
  };
  $("#depot-status").textContent = !state.fleet?.depot
    ? "Not set up"
    : holder == null
      ? queue.length ? `${queue.length} waiting` : "Dock free"
      : `In use by ${name(holder)}` + (queue.length ? ` · ${queue.length} waiting` : "");
}

function renderFleetMap(turtles, f) {
  const svg = $("#fleet-map");
  const size = 400;
  const items = turtles.map((t) => ({ t, p: mapPos(t) })).filter((o) => o.p?.frame === "world");
  const jobs = turtles.map((t) => ({ t, box: jobBox(t.status?.fleetJob?.args) })).filter((j) => j.box);
  const areas = f.protect?.areas ?? [];
  const pts = [
    ...items.map((o) => o.p),
    ...jobs.flatMap(({ box }) => [{ x: box.x1, z: box.z1 }, { x: box.x2, z: box.z2 }]),
    ...areas.flatMap((a) => [{ x: a.x1, z: a.z1 }, { x: a.x2, z: a.z2 }]),
  ];
  if (f.depot) pts.push(f.depot);
  const plans = state.view === "fleet" ? plannedFleetJob() : [];
  for (const p of plans) pts.push({ x: p.x1, z: p.z1 }, { x: p.x2, z: p.z2 });
  if (!pts.length) {
    svg.innerHTML = `<text class="map-note" x="200" y="204" text-anchor="middle">Turtles appear here once GPS knows where they are</text>`;
    return;
  }
  const v = viewport(pts, size, true, 16);
  let out = gridLines(v);
  for (const a of areas) {
    out += rect(v, a.x1, a.z1, a.x2, a.z2, "area", `Protected: ${a.name || "unnamed"} (Y ${a.y1} to ${a.y2})`);
    out += `<text class="area-label" x="${v.sx(Math.min(a.x1, a.x2) - 0.5)}" y="${v.sy(Math.min(a.z1, a.z2) - 0.5) - 4}">${escapeXml(a.name || "")}</text>`;
  }
  for (const p of plans) out += rect(v, p.x1, p.z1, p.x2, p.z2, "plan", p.label);
  for (const { t, box } of jobs) {
    const a = t.status.fleetJob.args;
    out += rect(v, box.x1, box.z1, box.x2, box.z2, "job-area", `${nameOf(t)}: ${KIND_NAMES[a.kind]} (${a.kind === "branchMine" ? `Y ${a.y}` : `Y ${a.yTop} to ${a.yBottom}`})`);
  }
  if (f.depot) {
    const [x, y] = [v.sx(f.depot.x), v.sy(f.depot.z)];
    out += `<g><rect class="depot-mark" x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2"/><text class="depot-label" x="${x}" y="${y + 3}" text-anchor="middle">D</text>
      <title>Depot dock: ${f.depot.x}, ${f.depot.y}, ${f.depot.z}</title></g>`;
  }
  for (const { t, p } of items) {
    const st = turtleState(t);
    const selected = t.id === state.selected;
    if (selected) out += `<circle class="selected-ring" cx="${v.sx(p.x)}" cy="${v.sy(p.z)}" r="11"/>`;
    out += `<g class="pick-mark" data-id="${t.id}">${arrow(`mark mark-${st.key}`, v.sx(p.x), v.sy(p.z), p.dir, selected ? 9 : 7)}
      <title>${escapeXml(nameOf(t))} · ${st.label} · ${p.x}, ${p.y}, ${p.z}</title></g>`;
  }
  out += `<text class="compass" x="${size - 8}" y="16" text-anchor="end">N ↑</text>`;
  out += `<text class="scale" x="8" y="${size - 8}">Grid: ${fmt(v.step)} block${v.step === 1 ? "" : "s"}</text>`;
  svg.innerHTML = out;
}

// Fleet settings form ------------------------------------------------------------

function setFleet(fleet) {
  if (!fleet) return;
  state.fleet = fleet;
  if (!state.fleetDirty) fillFleetForm();
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}

function fillFleetForm() {
  const f = state.fleet;
  if (!f) return;
  for (const el of $$("#fleet-settings [data-field]")) {
    const v = getPath(f, el.dataset.field);
    el.value = Array.isArray(v) ? v.join("\n") : v ?? (el.tagName === "SELECT" ? el.options[0].value : "");
  }
  if (!f.depot) {
    $('[data-field="depot.junk"]').value = "down";
    $('[data-field="depot.valuables"]').value = "north";
    $('[data-field="depot.fuel"]').value = "west";
  }
  $("#areas").replaceChildren(...(f.protect?.areas ?? []).map(areaRow));
  renderDockApproach();
  setSaveMsg("");
}

function areaRow(a = {}) {
  const row = $("#area-row").content.firstElementChild.cloneNode(true);
  $(".area-name", row).value = a.name ?? "";
  for (const input of $$("[data-k]", row)) input.value = a[input.dataset.k] ?? "";
  $(".area-remove", row).addEventListener("click", () => {
    row.remove();
    markFleetDirty();
  });
  return row;
}

function collectFleet() {
  const out = structuredClone(state.fleet ?? {});
  for (const el of $$("#fleet-settings [data-field]")) {
    let v = el.value;
    if (el.tagName === "TEXTAREA") v = v.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (el.type === "number") v = v === "" ? null : Number(v);
    setPath(out, el.dataset.field, v);
  }
  const d = out.depot;
  const filled = [d.x, d.y, d.z].filter((n) => n !== null).length;
  if (filled === 0) out.depot = null;
  else if (filled < 3) return { error: "Fill in all three dock coordinates, or clear them." };
  out.protect.areas = $$("#areas .area").map((row) => {
    const a = { name: $(".area-name", row).value.trim() };
    for (const input of $$("[data-k]", row)) a[input.dataset.k] = input.value === "" ? null : Number(input.value);
    return a;
  });
  if (out.protect.areas.some((a) => ["x1", "y1", "z1", "x2", "y2", "z2"].some((k) => a[k] === null))) {
    return { error: "Every protected area needs both corners filled in." };
  }
  return { fleet: out };
}

function markFleetDirty() {
  state.fleetDirty = true;
  setSaveMsg("Unsaved changes");
}

function setSaveMsg(text, error = false) {
  const el = $("#fleet-save-msg");
  el.textContent = text;
  el.style.color = error ? "var(--critical)" : "";
}

// Setup --------------------------------------------------------------------------

function setTab(name) {
  for (const tab of $$(".tab[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const form of $$(".job-form")) form.hidden = form.dataset.job !== name;
  store.set("jobTab", name);
}

function setFleetTab(name) {
  for (const tab of $$(".tab[data-fleet-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.fleetTab === name));
  for (const el of $$("#fleet-job-form [data-kind]")) {
    el.hidden = el.dataset.kind !== name;
    // Disabled fields skip validation, so the hidden tab can't block submitting.
    for (const input of $$("input, select", el)) input.disabled = el.hidden;
  }
  store.set("fleetTab", name);
  renderFleetPreview();
}

function setMapMode(mode) {
  state.mapMode = mode;
  store.set("mapMode", mode);
  for (const tab of $$(".tab[data-map]")) tab.setAttribute("aria-selected", String(tab.dataset.map === mode));
  invalidate("detail");
}

function setupInstallSteps() {
  const commands = {
    ".install-cmd": `wget ${location.origin}/turtle.lua startup.lua`,
    ".install-disk": `wget ${location.origin}/install.lua disk/startup.lua`,
  };
  for (const list of $$(".install-steps")) {
    list.append($("#install-steps").content.cloneNode(true));
    for (const [sel, cmd] of Object.entries(commands)) $(sel, list).textContent = cmd;
    for (const btn of $$(".copy", list)) {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(commands[btn.dataset.copy]);
          toast("Copied to clipboard");
        } catch {
          toast("Couldn't copy. Select the text instead.", "warn");
        }
      });
    }
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
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

  // Fleet-wide controls
  $("#btn-install").addEventListener("click", () => $("#install-dialog").showModal());
  $("#btn-pause-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "pause" }));
  $("#btn-resume-all").addEventListener("click", () => sendRaw({ type: "cmd", id: "all", action: "resume" }));
  $("#btn-recall-all").addEventListener("click", () => {
    if (confirm("Cancel every turtle's job and send them all home?")) sendRaw({ type: "cmd", id: "all", action: "goHome" });
  });
  $("#btn-update-all").addEventListener("click", () => {
    if (confirm("Download the latest script to every idle turtle and reboot them? Busy turtles skip it.")) {
      sendRaw({ type: "cmd", id: "all", action: "update" });
    }
  });
  for (const tab of $$(".tab[data-view]")) tab.addEventListener("click", () => setView(tab.dataset.view));

  $("#turtle-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    invalidate("list");
  });
  for (const chip of $$(".chip")) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      store.set("filter", state.filter);
      invalidate("list");
    });
  }

  // One turtle
  $("#btn-pause").addEventListener("click", () => command("pause"));
  $("#btn-resume").addEventListener("click", () => command("resume"));
  $("#btn-cancel").addEventListener("click", () => {
    if (confirm("Cancel this job and send the turtle home?")) command("goHome");
  });
  $("#btn-rename").addEventListener("click", startRename);
  $("#t-name").addEventListener("click", startRename);
  $("#rename-cancel").addEventListener("click", endRename);
  $("#rename-input").addEventListener("keydown", (event) => {
    if (event.key === "Escape") endRename();
  });
  $("#rename-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const t = currentTurtle();
    const label = $("#rename-input").value.trim();
    if (t && label) renameTurtle(t, label);
    endRename();
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
  $("#btn-home-coords").addEventListener("click", () => {
    const form = $("#home-form");
    const s = currentTurtle()?.status ?? {};
    const w = s.homeWorld ?? s.world;
    if (!s.world) {
      toast("Setting home by coordinates needs GPS. Move the turtle a block first.", "warn");
      return;
    }
    for (const k of ["x", "y", "z"]) form.elements[k].value = w?.[k] ?? "";
    form.elements.facing.value = s.homeFacing ?? s.facing ?? "north";
    form.hidden = false;
  });
  $("#btn-home-cancel").addEventListener("click", () => ($("#home-form").hidden = true));
  $("#home-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    command("setHome", {
      x: Number(form.elements.x.value), y: Number(form.elements.y.value), z: Number(form.elements.z.value),
      facing: form.elements.facing.value,
    });
    form.hidden = true;
  });

  for (const btn of $$("[data-cmd]")) btn.addEventListener("click", () => command(btn.dataset.cmd));
  for (const tab of $$(".tab[data-tab]")) {
    tab.addEventListener("click", () => {
      setTab(tab.dataset.tab);
      invalidate("detail");
    });
  }
  for (const tab of $$(".tab[data-map]")) tab.addEventListener("click", () => setMapMode(tab.dataset.map));
  $("#map").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-id]");
    if (pick) select(Number(pick.dataset.id));
  });

  for (const form of $$(".job-form")) {
    form.addEventListener("input", () => invalidate("detail"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const args = {};
      for (const [key, value] of new FormData(form)) args[key] = Number(value);
      command(form.dataset.job, args);
    });
  }

  $("#auto-dig").checked = store.get("autoDig") === "1";
  $("#auto-dig").addEventListener("change", (event) => store.set("autoDig", event.target.checked ? "1" : null));

  // Fleet page
  for (const tab of $$(".tab[data-fleet-tab]")) tab.addEventListener("click", () => setFleetTab(tab.dataset.fleetTab));
  const jobForm = $("#fleet-job-form");
  jobForm.addEventListener("input", (event) => {
    const { name, value } = event.target;
    const presets = { preset: "y", bottomPreset: "yBottom" };
    if (presets[name] && value !== "") jobForm.elements[presets[name]].value = value;
    for (const [preset, field] of Object.entries(presets)) {
      if (name === field) {
        const select = jobForm.elements[preset];
        select.value = [...select.options].some((o) => o.value === value) ? value : "";
      }
    }
    renderFleetPreview();
    invalidate("fleet");
  });
  jobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const { kind, params } = fleetParams();
    const ids = pickedTurtles().map((t) => t.id);
    if (!ids.length) {
      toast("Pick at least one turtle first.", "warn");
      return;
    }
    $("#fleet-job-result").hidden = true;
    sendRaw({ type: "fleetJob", kind, ids, params });
  });
  for (const btn of $$("[data-use-pos]")) {
    btn.addEventListener("click", () => {
      const w = currentTurtle()?.status?.world;
      if (!w) return;
      const [kx, kz] = btn.dataset.usePos.split(",");
      jobForm.elements[kx].value = w.x;
      jobForm.elements[kz].value = w.z;
      if (kx === "x1" && jobForm.elements.yTop.value === "") jobForm.elements.yTop.value = w.y - 1;
      renderFleetPreview();
      invalidate("fleet");
    });
  }
  $("#pick-ready").addEventListener("click", () => {
    state.picked = new Set(sortedTurtles().filter((t) => !notReady(t)).map((t) => t.id));
    invalidate("fleet");
  });
  $("#pick-none").addEventListener("click", () => {
    state.picked.clear();
    invalidate("fleet");
  });
  for (const btn of $$("[data-bulk]")) {
    btn.addEventListener("click", () => {
      const ids = pickedTurtles().map((t) => t.id);
      if (!ids.length) {
        toast("Pick some turtles first.", "warn");
        return;
      }
      const action = btn.dataset.bulk;
      const n = `${ids.length} turtle${ids.length === 1 ? "" : "s"}`;
      if (action === "goHome" && !confirm(`Cancel the jobs of ${n} and send them home?`)) return;
      if (action === "setHome" && !confirm(`Make the current spot of each of ${n} its new home?`)) return;
      sendRaw({ type: "cmd", ids, action, args: {} });
    });
  }
  $("#btn-bulk-rename").addEventListener("click", () => {
    $("#bulk-rename").hidden = false;
    renderBulkRenamePreview();
    $("#bulk-rename").elements.prefix.focus();
  });
  $("#bulk-rename-cancel").addEventListener("click", () => ($("#bulk-rename").hidden = true));
  $("#bulk-rename").addEventListener("input", renderBulkRenamePreview);
  $("#bulk-rename").addEventListener("submit", (event) => {
    event.preventDefault();
    const plan = bulkRenamePlan().filter((p) => p.t.online);
    if (!plan.length || !$("#bulk-rename").elements.prefix.value.trim()) {
      toast("Pick some online turtles and enter a name first.", "warn");
      return;
    }
    for (const { t, label } of plan) {
      sendRaw({ type: "cmd", id: t.id, action: "setLabel", args: { label } });
      t.label = label;
    }
    toast(`Renamed ${plan.length} turtle${plan.length === 1 ? "" : "s"}.`);
    $("#bulk-rename").hidden = true;
    invalidate("list", "detail", "fleet");
  });
  $("#fleet-map").addEventListener("click", (event) => {
    const pick = event.target.closest("[data-id]");
    if (!pick) return;
    select(Number(pick.dataset.id));
    setView("turtles");
  });

  for (const sideSelect of $$("select.side")) {
    sideSelect.innerHTML = Object.entries(SIDES).map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  }
  $("#fleet-settings").addEventListener("input", () => {
    markFleetDirty();
    renderDockApproach();
  });
  $("#btn-add-area").addEventListener("click", () => {
    const w = currentTurtle()?.status?.world;
    // Start a new area as a 20x20 box around the selected turtle, if it has GPS.
    const row = areaRow(w ? { x1: w.x - 10, y1: w.y - 10, z1: w.z - 10, x2: w.x + 10, y2: w.y + 20, z2: w.z + 10 } : {});
    $("#areas").append(row);
    $(".area-name", row).focus();
    markFleetDirty();
  });
  $("#btn-dock-here").addEventListener("click", () => {
    const w = currentTurtle()?.status?.world;
    if (!w) return;
    for (const k of ["x", "y", "z"]) $(`[data-field="depot.${k}"]`).value = w[k];
    if (!$('[data-field="travelY"]').value) $('[data-field="travelY"]').value = w.y + 20;
    markFleetDirty();
  });
  $("#btn-save-fleet").addEventListener("click", () => {
    const { fleet, error } = collectFleet();
    if (error) {
      setSaveMsg(error, true);
      return;
    }
    setSaveMsg("Saving…");
    sendRaw({ type: "saveFleet", fleet });
  });
  $("#btn-revert-fleet").addEventListener("click", () => {
    state.fleetDirty = false;
    fillFleetForm();
  });
  $("#btn-release-dock").addEventListener("click", () => {
    if (confirm("Release the dock? Only do this if the turtle using it is stuck or gone, or two turtles may meet in the depot column.")) {
      sendRaw({ type: "releaseDepot" });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.("input:not([type=checkbox]), select, textarea")) return;
    if ($("#app").hidden || $("#install-dialog").open) return;

    if (event.key === "/") {
      event.preventDefault();
      $("#turtle-search").focus();
      return;
    }
    if ($("#turtle").hidden) return;
    if (event.key === "Escape") {
      if (currentTurtle()?.status?.job) command("pause");
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

  // Keep "last seen" times fresh, and remember which server copy we're on.
  setInterval(() => {
    invalidate("list", "detail", "fleet");
    rememberServer();
  }, 15000);
  addEventListener("pagehide", rememberServer);
}

applyTheme(store.get("theme"));
buildInventory();
setupInstallSteps();
setTab(store.get("jobTab") === "tunnel" ? "tunnel" : "quarry");
setFleetTab(store.get("fleetTab") === "areaQuarry" ? "areaQuarry" : "branchMine");
setMapMode(state.mapMode);
bindEvents();
setView(state.view);

const session = store.get("session");
if (session) {
  state.loggedIn = true;
  showApp();
  connect({ session });
} else {
  showLogin();
}
